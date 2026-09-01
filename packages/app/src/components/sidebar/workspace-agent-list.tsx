import { memo, useCallback, useMemo, type ComponentType, type ReactNode } from "react";
import { Pressable, Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { AgentStateBucketDot } from "@/components/agent-status-dot";
import { getProviderIcon, type ProviderIconComponent } from "@/components/provider-icons";
import {
  hasSidebarAgentRows,
  type SidebarAgentRows,
} from "@/components/sidebar/display-preferences/agent-rows";
import { useSidebarAgentRows } from "@/components/sidebar/display-preferences/model";
import { STATUS_BUCKET_LABELS } from "@/hooks/sidebar-status-view-model";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePanelStore } from "@/stores/panel-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { isAgentListExpanded } from "@/stores/sidebar-collapsed-sections-store/state";
import type { Theme } from "@/styles/theme";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import type { WorkspaceAgentEntry } from "@/utils/workspace-agent-activity";
import { navigateToAgent } from "@/utils/navigate-to-agent";

/**
 * The agents inside one workspace row.
 *
 * Only drawn for a workspace holding more than one active root agent — see `agent-rows.ts` for
 * why. Both sidebar list modes mount this, so the rule and the layout live here rather than
 * twice in two row renderers.
 *
 * Rows carry a dot and a title and nothing else. The workspace row above already answered branch,
 * host, change request, and CI; repeating any of it per agent is what would make the sidebar
 * unreadable.
 */

/**
 * `withUnistyles` per icon, cached at module scope. The wrapper has to be a stable component type:
 * building one during render would give the icon a new identity on every update and remount it.
 *
 * Keyed by the component `getProviderIcon` resolves to, not by the provider id. A provider id is
 * an arbitrary string, so keying on it would keep a separate wrapper for every unrecognised
 * provider ever rendered even though they all resolve to one fallback glyph. Keying on the
 * resolved component collapses those to a single entry, and a WeakMap holds nothing the icon
 * module has itself released.
 */
type ThemedProviderIcon = ComponentType<{
  size: number;
  uniProps: (theme: Theme) => { color: string };
}>;

const themedProviderIcons = new WeakMap<ProviderIconComponent, ThemedProviderIcon>();

function getThemedProviderIcon(provider: string): ThemedProviderIcon {
  const source = getProviderIcon(provider);
  const cached = themedProviderIcons.get(source);
  if (cached) return cached;
  // `withUnistyles` supplies `color` from `uniProps`, which the source component still declares
  // as required — hence the cast rather than a wider `ProviderIconProps`.
  const themed = withUnistyles(source) as unknown as ThemedProviderIcon;
  themedProviderIcons.set(source, themed);
  return themed;
}

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const extraMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

export interface SidebarAgentListModel {
  agents: readonly WorkspaceAgentEntry[];
  /** Whether this workspace draws a disclosure and a list at all. */
  visible: boolean;
  expanded: boolean;
  toggle: () => void;
}

/**
 * The three fields both pieces need. `SidebarWorkspaceEntry` satisfies it structurally, so callers
 * pass the entry they already hold.
 */
export interface SidebarAgentListSource {
  workspaceKey: string;
  serverId: string;
  agents: readonly WorkspaceAgentEntry[];
}

/**
 * Statuses that open a workspace's list on their own. Deliberately the two an agent cannot leave
 * without you — `attention` means finished, which is worth a dot but not worth rearranging the
 * sidebar for every time a turn ends.
 */
function hasBlockedAgent(agents: readonly WorkspaceAgentEntry[]): boolean {
  return agents.some((agent) => agent.status === "needs_input" || agent.status === "failed");
}

export function useSidebarAgentListModel(input: SidebarAgentListSource): SidebarAgentListModel {
  const mode: SidebarAgentRows = useSidebarAgentRows();
  // A blocked agent opens its list without being asked. This is the case the sub-list exists for,
  // and it is the case where reaching the toggle is most awkward — a phone, one thumb, a 6px dot.
  // It moves the default rather than forcing the state, so a workspace you collapsed stays
  // collapsed: an override always wins.
  const expandedByDefault = mode === "expanded" || hasBlockedAgent(input.agents);
  // Select this workspace's answer, not the map it lives in. The store replaces the whole
  // overrides map on every toggle, and this hook runs twice per row, so subscribing to the map
  // would re-render every row in the sidebar each time one workspace expanded.
  const expanded = useSidebarCollapsedSectionsStore((state) =>
    isAgentListExpanded(state, input.workspaceKey, expandedByDefault),
  );
  const toggleAgentListExpanded = useSidebarCollapsedSectionsStore(
    (state) => state.toggleAgentListExpanded,
  );

  const visible = hasSidebarAgentRows({ agentCount: input.agents.length, mode });

  const toggle = useCallback(() => {
    toggleAgentListExpanded(input.workspaceKey, expandedByDefault);
  }, [toggleAgentListExpanded, input.workspaceKey, expandedByDefault]);

  return useMemo(
    () => ({ agents: input.agents, visible, expanded, toggle }),
    [input.agents, visible, expanded, toggle],
  );
}

/**
 * The count and chevron that sit on the workspace row itself.
 *
 * Its own pressable rather than part of the row press: the row navigates to the workspace, and a
 * disclosure that navigated as a side effect of being opened would be a trap.
 */
/**
 * The row's leading slot: its status indicator at rest, an expand chevron while the row is
 * hovered. Same shape as `ProjectLeadingVisual` — a project row swaps its icon for a chevron the
 * same way, so a workspace row that expands says so in the same place.
 *
 * Unlike a project row it has to be its own press target. A project header's press already
 * toggles collapse, so its chevron can be decoration; a workspace row's press navigates, so a
 * chevron that inherited it would look like a disclosure and open the workspace instead.
 *
 * `hitSlop` is what makes it usable on touch, where there is no hover to reveal the chevron and
 * the visible target is a 6px dot. The count on the meta line is the hint that there is anything
 * to open.
 */
export const SidebarAgentListToggle = memo(function SidebarAgentListToggle({
  model,
  isHovered,
  children,
}: {
  model: SidebarAgentListModel;
  isHovered: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const accessibilityState = useMemo(() => ({ expanded: model.expanded }), [model.expanded]);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      // The row beneath navigates. Without this, expanding also opens the workspace.
      event.stopPropagation();
      model.toggle();
    },
    [model],
  );

  // A workspace with nothing to expand keeps its plain leading slot: no press target, no chevron.
  if (!model.visible) {
    return children;
  }

  const Chevron = model.expanded ? ThemedChevronDown : ThemedChevronRight;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={t("sidebar.agentList.toggle", { count: model.agents.length })}
      onPress={handlePress}
      hitSlop={TOGGLE_HIT_SLOP}
      style={styles.toggle}
      testID="sidebar-agent-list-disclosure"
    >
      {isHovered ? <Chevron size={14} uniProps={extraMutedColorMapping} /> : children}
    </Pressable>
  );
});

export const SidebarWorkspaceAgentRows = memo(function SidebarWorkspaceAgentRows({
  workspace,
}: {
  workspace: SidebarAgentListSource;
}) {
  const model = useSidebarAgentListModel(workspace);
  if (!model.visible || !model.expanded) {
    return null;
  }
  return (
    <View style={styles.list} testID="sidebar-agent-list">
      {model.agents.map((agent) => (
        <SidebarAgentRow key={agent.agentId} serverId={workspace.serverId} agent={agent} />
      ))}
    </View>
  );
});

const SidebarAgentRow = memo(function SidebarAgentRow({
  serverId,
  agent,
}: {
  serverId: string;
  agent: WorkspaceAgentEntry;
}) {
  const { t } = useTranslation();
  const label = agent.title || t("agentList.fallbackTitle");
  // Two agents a provider has not named yet share one fallback title, so the visible text alone
  // announces them identically. The row already draws what tells them apart — the provider mark
  // and the status dot — and this is that, spoken. `STATUS_BUCKET_LABELS` is what the project
  // row's leading visual already announces (`project-leading-visual.tsx:180`).
  const accessibilityLabel = `${label}, ${agent.provider}, ${STATUS_BUCKET_LABELS[agent.status]}`;
  // Which agent this is matters most in exactly the case that draws this list: a Claude and a
  // Codex agent in one workspace are otherwise two identical rows. History rows already pair the
  // provider icon with the title this way (`components/agent-list.tsx:285`).
  const ProviderIcon = getThemedProviderIcon(agent.provider);

  // A compact sidebar is an overlay covering the pane it navigates. A workspace row closes it on
  // press (`left-sidebar.tsx` hands its rows `closeSidebar`); an agent row has to do the same, or
  // the agent changes behind the sidebar and the tap looks like it did nothing.
  const isCompact = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const handlePress = useCallback(() => {
    navigateToAgent({ serverId, agentId: agent.agentId });
    if (isCompact) {
      showMobileAgent();
    }
  }, [serverId, agent.agentId, isCompact, showMobileAgent]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={handlePress}
      style={rowStyle}
      testID={`sidebar-agent-row-${agent.agentId}`}
    >
      <View style={styles.rowDot} testID={`sidebar-agent-row-dot-${agent.agentId}`}>
        <AgentStateBucketDot bucket={agent.status} showInactive />
      </View>
      <View style={styles.rowProviderIcon}>
        <ProviderIcon size={PROVIDER_ICON_SIZE} uniProps={extraMutedColorMapping} />
      </View>
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
});

const PROVIDER_ICON_SIZE = 12;

/**
 * The visible target is a 14x20 slot, well under the 44pt/48dp minimum, and on touch it is the
 * only way to open the sub-list — a project row can be tapped anywhere because its press is free,
 * while this row's press navigates.
 *
 * Asymmetric because the space is. Above and below is row padding and left is the sidebar's own
 * gutter, so growing there costs nothing; right is the workspace title, so it stays put. Lands at
 * roughly 34x44.
 */
const TOGGLE_HIT_SLOP = { top: 12, bottom: 12, left: 12, right: 8 };

/**
 * Left inset for the sub-list, set so an agent's status dot shares a left edge with the agent
 * count on the meta line above it — which is itself on the workspace title's rail. The rows then
 * hang under the workspace's text rather than starting a second column of their own.
 *
 * Not a spacing token: the rail is fixed by the geometry of the row above — its padding and its
 * leading status indicator — which no token expresses. It was tuned against the hovered layout
 * while the slot still narrowed on hover, so it read two pixels short until the slot was pinned.
 * `e2e/browser/sidebar-agent-rows.spec.ts` measures both boxes and fails if they drift.
 */
const AGENT_LIST_RAIL_INSET = 24;

const rowStyle = ({ pressed }: { pressed: boolean }) => [styles.row, pressed && styles.rowPressed];

const styles = StyleSheet.create((theme) => ({
  // Leading, next to the title, not trailing. The trailing slot is overlaid by the kebab and
  // faded by a 48px scrim on hover (`ui/trailing-action-scrim.tsx`) — fine for a diff stat nobody
  // clicks, wrong for a control you hover the row to reach. Leading also matches how project and
  // status-group rows already say "this expands".
  // Width is pinned to the resting slot (`workspaceStatusDot` is `iconSize.md`). Sizing to the
  // content instead let the 14px chevron shrink the slot on hover, sliding the title and meta
  // line two pixels left and back as the pointer crossed the row.
  toggle: {
    alignItems: "center",
    justifyContent: "center",
    width: theme.iconSize.md,
    height: 20,
    flexShrink: 0,
  },
  list: {
    paddingLeft: AGENT_LIST_RAIL_INSET,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    height: 24,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface1,
  },
  // Sized to the dot itself, not padded around it: the wrapper's left edge is the rail, so any
  // centering slack inside it would show up as drift against the count.
  rowDot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    alignItems: "center",
  },
  rowProviderIcon: {
    width: PROVIDER_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
