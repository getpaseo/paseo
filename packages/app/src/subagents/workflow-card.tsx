import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import type {
  ProviderSubagentDescriptorPayload,
  ProviderSubagentWorkflowAgentPayload,
} from "@getpaseo/protocol/messages";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useOptionalPaneContext } from "@/panels/pane-context";
import type { Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { providerSubagentKey, useProviderSubagentStore } from "./provider-store";

/**
 * A running workflow as Claude draws it: a fixed-width card with the workflow's name, its agent
 * count and elapsed time, and one small square per agent. A finished workflow folds back into
 * its ordinary tool call row, as it does in Claude.
 */

// Claude's swarm geometry: 6px squares on an 8px pitch, at most 8 rows, in a 318px card.
const CARD_WIDTH = 318;
const CELL_SIZE = 6;
const CELL_GAP = 2;
const CELL_PITCH = CELL_SIZE + CELL_GAP;
const MAX_ROWS = 8;
// Squares per row in a full-width card beside the chevron, until the grid measures itself.
const DEFAULT_CELLS_PER_ROW = 34;
// An agent that reports nothing for this long reads as stalled.
const STALL_MS = 90_000;

// Claude's swarm palette. Done and queued read off the foreground so they sit in either theme.
const RUNNING_COLOR = "#257de0";
const STALLED_COLOR = "#fbb315";
const ERROR_COLOR = "#dc3c3d";
const NEUTRAL_ALPHA = 0.2;

type CellState = "done" | "running" | "stalled" | "error" | "stopped" | "pending";

interface CellCounts {
  total: number;
  done: number;
  running: number;
  stalled: number;
  error: number;
  stopped: number;
  pending: number;
}

interface Cell {
  state: CellState;
  label: string | null;
}

const ThemedChevronRight = withUnistyles(ChevronRight);
const chevronColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

/**
 * Whether a Workflow call draws as a card: while its workflow runs, and, when `beforeLaunch` is
 * set, before the workflow has reported at all. Otherwise it keeps its ordinary tool call row.
 */
export function useWorkflowCardShown(input: {
  serverId: string | undefined;
  parentAgentId: string | undefined;
  subagentId: string | undefined;
  toolStatus: string;
  beforeLaunch: boolean;
}): boolean {
  const { serverId, parentAgentId, subagentId, toolStatus, beforeLaunch } = input;
  const status = useProviderSubagentStore((state) =>
    serverId && parentAgentId && subagentId
      ? (state.descriptors.get(providerSubagentKey(serverId, parentAgentId, subagentId))?.status ??
        null)
      : undefined,
  );
  if (status === undefined) return false;
  if (status === null) {
    return beforeLaunch && (toolStatus === "running" || toolStatus === "executing");
  }
  return status === "running";
}

export const WorkflowToolCallCard = memo(function WorkflowToolCallCard({
  serverId,
  parentAgentId,
  subagentId,
  detail,
}: {
  serverId: string;
  parentAgentId: string;
  subagentId: string;
  detail: ToolCallDetail | undefined;
}): ReactElement {
  const descriptor = useProviderSubagentStore((state) =>
    state.descriptors.get(providerSubagentKey(serverId, parentAgentId, subagentId)),
  );
  return (
    <WorkflowCard
      descriptor={descriptor ?? null}
      title={readWorkflowTitle(detail)}
      parentAgentId={parentAgentId}
      subagentId={subagentId}
    />
  );
});

function WorkflowCard({
  descriptor,
  title,
  parentAgentId,
  subagentId,
}: {
  descriptor: ProviderSubagentDescriptorPayload | null;
  title: string | null;
  parentAgentId: string;
  subagentId: string;
}): ReactElement {
  const { t } = useTranslation();
  const pane = useOptionalPaneContext();
  const isCompact = useIsCompactFormFactor();
  const [hovered, setHovered] = useState(false);
  const onHoverIn = useCallback(() => setHovered(true), []);
  const onHoverOut = useCallback(() => setHovered(false), []);
  const now = useNow(1000);
  const agents = descriptor?.workflowAgents ?? EMPTY_AGENTS;
  const cells = useMemo(() => agents.map((agent) => toCell(agent, now)), [agents, now]);
  const counts = useMemo(() => countCells(cells), [cells]);
  const startedAt = descriptor ? Date.parse(descriptor.createdAt) : Number.NaN;
  const canOpen = pane !== null;
  const open = useCallback(() => {
    pane?.openPreferredTarget(
      { kind: "provider_subagent", parentAgentId, subagentId },
      "subagents",
    );
  }, [pane, parentAgentId, subagentId]);

  return (
    <PressHighlight
      onPress={open}
      disabled={!canOpen}
      accessibilityRole="button"
      accessibilityHint={summarize(t, counts)}
      accessibilityLabel={
        title ? t("subagents.workflowCardOpen", { title }) : t("subagents.workflowCardOpenUntitled")
      }
      onHoverIn={onHoverIn}
      onHoverOut={onHoverOut}
      style={[styles.card, hovered && canOpen ? styles.cardHovered : null]}
      highlightStyle={styles.cardHovered}
      testID="workflow-card"
    >
      <View style={styles.body}>
        {title ? (
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        ) : null}
        <View style={styles.meta}>
          <Text style={styles.metaLabel}>
            {descriptor ? t("subagents.workflowCardLabel") : t("subagents.workflowCardStarting")}
          </Text>
          {counts.total > 0 ? (
            <Text style={styles.metaText}>
              {t("subagents.workflowAgentCount", { count: counts.total })}
            </Text>
          ) : null}
          {Number.isFinite(startedAt) ? (
            <Text style={styles.metaText}>{formatElapsed(now - startedAt)}</Text>
          ) : null}
        </View>
        <View style={styles.gridSlot}>
          <AgentCells cells={cells} counts={counts} />
        </View>
        {isNative || isCompact ? (
          <Text style={styles.metaLabel}>{summarize(t, counts)}</Text>
        ) : null}
      </View>
      {canOpen ? (
        <View style={styles.chevron}>
          <ThemedChevronRight size={14} uniProps={chevronColorMapping} />
        </View>
      ) : null}
    </PressHighlight>
  );
}

function AgentCells({ cells, counts }: { cells: Cell[]; counts: CellCounts }): ReactElement {
  const { t } = useTranslation();
  const [cellsPerRow, setCellsPerRow] = useState(DEFAULT_CELLS_PER_ROW);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setCellsPerRow(Math.max(1, Math.floor(event.nativeEvent.layout.width / CELL_PITCH)));
  }, []);
  // Past what fits, Claude draws the mix of states rather than each agent. The ghost square
  // keeps the last slot.
  const maxCells = cellsPerRow * MAX_ROWS - 1;
  const shown = useMemo(() => {
    const drawn: Cell[] =
      cells.length <= maxCells
        ? cells
        : apportionCells(counts, maxCells).map((state) => ({ state, label: null }));
    // Agents never reorder or disappear: launch position is their identity.
    return drawn.map((cell, position) => ({ state: cell.state, label: cell.label, position }));
  }, [cells, counts, maxCells]);
  return (
    <View
      style={styles.grid}
      onLayout={handleLayout}
      accessibilityRole="image"
      accessibilityLabel={summarize(t, counts)}
      testID="workflow-agents-grid"
    >
      {shown.map((cell) => (
        <AgentCell
          key={cell.position}
          position={cell.position}
          state={cell.state}
          label={cell.label}
        />
      ))}
      <GhostCell />
    </View>
  );
}

const AgentCell = memo(function AgentCell({
  position,
  state,
  label,
}: {
  position: number;
  state: CellState;
  label: string | null;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Tooltip delayDuration={150} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <View style={styles.cellHitArea}>
          <View
            style={[
              styles.cell,
              styles[state],
              state === "running" && isWeb ? runningPulse(position) : null,
            ]}
          />
        </View>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={4}>
        <Text style={styles.tooltipContent}>{t(`subagents.workflowAgentState.${state}`)}</Text>
        {label ? (
          <Text style={styles.tooltipDetail} numberOfLines={1}>
            {label}
          </Text>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
});

/** Claude's last square while a workflow runs: room for agents it has not launched yet. */
function GhostCell(): ReactElement {
  const { t } = useTranslation();
  useEffect(ensureSwarmKeyframes, []);
  return (
    <Tooltip delayDuration={150} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <View style={styles.cellHitArea}>
          <View style={[styles.cell, styles.ghost, isWeb ? GHOST_PULSE : null]} />
        </View>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={4}>
        <Text style={styles.tooltipContent}>{t("subagents.workflowSwarmMoreAgents")}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const EMPTY_AGENTS: readonly ProviderSubagentWorkflowAgentPayload[] = [];

function toCell(agent: ProviderSubagentWorkflowAgentPayload, now: number): Cell {
  return { state: toCellState(agent, now), label: agent.label ?? null };
}

function toCellState(agent: ProviderSubagentWorkflowAgentPayload, now: number): CellState {
  switch (agent.status) {
    case "queued":
      return "pending";
    case "completed":
      return "done";
    case "failed":
      return "error";
    case "canceled":
      return "stopped";
    case "running":
      return agent.lastProgressAt != null && now - agent.lastProgressAt > STALL_MS
        ? "stalled"
        : "running";
  }
}

function countCells(cells: readonly Cell[]): CellCounts {
  const counts: CellCounts = {
    total: cells.length,
    done: 0,
    running: 0,
    stalled: 0,
    error: 0,
    stopped: 0,
    pending: 0,
  };
  for (const cell of cells) counts[cell.state] += 1;
  return counts;
}

/** `max` cells in proportion to the counts, every present state keeping at least one. */
function apportionCells(counts: CellCounts, max: number): CellState[] {
  const order: CellState[] = ["done", "running", "stalled", "error", "stopped", "pending"];
  const result = Object.fromEntries(order.map((state) => [state, 0])) as Record<CellState, number>;
  let used = 0;
  for (const state of order) {
    if (counts[state] > 0 && used < max) {
      result[state] = 1;
      used += 1;
    }
  }
  const rest = max - used;
  if (rest > 0) {
    const exact = order.map((state) => (counts[state] / counts.total) * rest);
    const floors = exact.map(Math.floor);
    let assigned = floors.reduce((sum, value) => sum + value, 0);
    const byRemainder = exact
      .map((value, index) => ({ index, remainder: value - floors[index] }))
      .sort((left, right) => right.remainder - left.remainder);
    for (const { index } of byRemainder) {
      if (assigned >= rest) break;
      floors[index] += 1;
      assigned += 1;
    }
    order.forEach((state, index) => {
      result[state] += floors[index];
    });
  }
  return order.flatMap((state) => Array.from({ length: result[state] }, () => state));
}

function summarize(t: TFunction, counts: CellCounts): string {
  if (counts.total === 0) return t("subagents.workflowSwarmWaiting");
  if (counts.stopped > 0) {
    return t("subagents.workflowSwarmSummaryStopped", {
      done: counts.done,
      total: counts.total,
      stopped: counts.stopped,
      running: counts.running,
      stalled: counts.stalled,
      failed: counts.error,
    });
  }
  return t("subagents.workflowSwarmSummary", {
    done: counts.done,
    total: counts.total,
    running: counts.running,
    stalled: counts.stalled,
    failed: counts.error,
  });
}

/** The workflow's name, read the way Claude reads it from the call's input. */
function readWorkflowTitle(detail: ToolCallDetail | undefined): string | null {
  if (detail?.type !== "unknown") return null;
  const input = detail.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.name === "string" && record.name) return record.name;
  if (typeof record.script === "string") {
    const match = record.script.slice(0, 4096).match(WORKFLOW_META_NAME);
    if (match?.[1]) return match[1];
  }
  if (typeof record.scriptPath === "string" && record.scriptPath) {
    return (
      record.scriptPath
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? null
    );
  }
  return null;
}

const WORKFLOW_META_NAME = /\bmeta\s*=\s*\{[^}]*?\bname\s*:\s*['"]([^'"]+)['"]/;

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// Each running square breathes on its own clock, so a swarm shimmers instead of blinking in step.
function runningPulse(position: number): object {
  const duration = 2.4 + ((position * 0.7548776662) % 1) * 1.4;
  const delay = -((position * 0.61803398875) % 1) * duration;
  return inlineUnistylesStyle({
    animation: `${PULSE_ANIMATION} ${duration.toFixed(2)}s ease-in-out ${delay.toFixed(2)}s infinite`,
  });
}

const PULSE_ANIMATION = "paseo-workflow-agent-pulse";
const GHOST_ANIMATION = "paseo-workflow-agent-ghost";
const GHOST_PULSE: object = inlineUnistylesStyle({
  animation: `2.2s ease-in-out infinite ${GHOST_ANIMATION}`,
});
const SWARM_KEYFRAMES_ID = "paseo-workflow-swarm-keyframes";
const SWARM_KEYFRAMES_CSS = `
@keyframes ${PULSE_ANIMATION} { 0%, 100% { opacity: 1 } 50% { opacity: .72 } }
@keyframes ${GHOST_ANIMATION} { 0%, 100% { opacity: .25 } 50% { opacity: .9 } }
@media (prefers-reduced-motion: reduce) {
  [style*="${PULSE_ANIMATION}"], [style*="${GHOST_ANIMATION}"] { animation: none !important }
}
`;

function ensureSwarmKeyframes(): void {
  if (!isWeb || typeof document === "undefined") return;
  if (document.getElementById(SWARM_KEYFRAMES_ID)) return;
  const style = document.createElement("style");
  style.id = SWARM_KEYFRAMES_ID;
  style.textContent = SWARM_KEYFRAMES_CSS;
  document.head.appendChild(style);
}

// Unistyles hands web its theme colors as CSS variables, which only CSS itself can fade.
function withAlpha(hex: string, alpha: number): string {
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) {
    return `color-mix(in srgb, ${hex} ${alpha * 100}%, transparent)`;
  }
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : value.slice(0, 6);
  const red = Number.parseInt(full.slice(0, 2), 16);
  const green = Number.parseInt(full.slice(2, 4), 16);
  const blue = Number.parseInt(full.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

const styles = StyleSheet.create((theme) => ({
  card: {
    alignSelf: "flex-start",
    width: CARD_WIDTH,
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginVertical: 6,
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 10,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardHovered: {
    backgroundColor: theme.colors.surface2,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  title: {
    fontSize: theme.fontSize.base,
    lineHeight: Math.ceil(theme.fontSize.base * 1.4),
    color: theme.colors.foreground,
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: 12,
    rowGap: 2,
    minHeight: 20,
  },
  metaLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  metaText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
    fontVariant: ["tabular-nums"],
  },
  gridSlot: {
    paddingTop: 6,
    paddingBottom: 2,
  },
  // Each square's hit area spans half the gap on every side, so the pointer never falls between
  // two squares and the tooltip moves from one agent straight to the next.
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    margin: -CELL_GAP / 2,
    maxHeight: MAX_ROWS * CELL_PITCH,
    overflow: "hidden",
  },
  cellHitArea: {
    padding: CELL_GAP / 2,
  },
  cell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: "transparent",
    ...(isWeb
      ? {
          transitionProperty: "background-color, border-color, opacity",
          transitionDuration: "160ms",
        }
      : {}),
  },
  done: {
    backgroundColor: withAlpha(theme.colors.foreground, NEUTRAL_ALPHA),
  },
  running: {
    backgroundColor: RUNNING_COLOR,
  },
  stalled: {
    backgroundColor: STALLED_COLOR,
  },
  error: {
    backgroundColor: ERROR_COLOR,
  },
  stopped: {
    borderColor: withAlpha(theme.colors.foreground, NEUTRAL_ALPHA),
  },
  pending: {
    borderColor: withAlpha(theme.colors.foreground, NEUTRAL_ALPHA),
  },
  ghost: {
    borderColor: withAlpha(theme.colors.foreground, NEUTRAL_ALPHA),
  },
  chevron: {
    height: 20,
    justifyContent: "center",
  },
  tooltipContent: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  tooltipDetail: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
