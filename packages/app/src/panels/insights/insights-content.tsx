import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { AgentHistoryEntry } from "@getpaseo/protocol/messages";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { formatTimeAgo } from "@/utils/time";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { getFocusedAgentId, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { StreamItem } from "@/types/stream";
import { computeAgentInsights, type JevDecision } from "./agent-insights";
import { entryTokens, originGroup, summarizeHistory } from "./session-history";

const EMPTY_ITEMS: StreamItem[] = [];
// Claude Code compacts around here; the line shows how close the session is.
const COMPACTION_SHARE = 0.75;
const MAX_STREAM_ROWS = 40;

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/** How the focused agent of this workspace is working: tools, Jev, context, cost. */
export function InsightsContent(input: { serverId: string; workspaceId: string }) {
  const { t } = useTranslation();
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  const agentId = useWorkspaceLayoutStore((state) =>
    getFocusedAgentId(workspaceKey ? state.layoutByWorkspace[workspaceKey] : null),
  );
  const agent = useSessionStore((state) =>
    agentId ? state.sessions[input.serverId]?.agents.get(agentId) : undefined,
  );
  const items = useSessionStore((state) =>
    agentId ? state.sessions[input.serverId]?.agentStreamTail.get(agentId) : undefined,
  );
  const insights = useMemo(() => computeAgentInsights(items ?? EMPTY_ITEMS), [items]);

  if (!agentId || !agent) {
    return (
      <ScrollView contentContainerStyle={styles.list} testID="insights-empty">
        <Text style={styles.muted}>{t("panels.insights.noAgent")}</Text>
        <SessionHistorySection serverId={input.serverId} />
      </ScrollView>
    );
  }

  const usage = agent.lastUsage;
  const used = usage?.contextWindowUsedTokens ?? null;
  const max = usage?.contextWindowMaxTokens ?? null;
  const share = used !== null && max ? Math.min(1, used / max) : null;
  const jevShare = insights.spanMs > 0 ? insights.jevLatencyMs / insights.spanMs : 0;
  const recentDecisions = insights.jevDecisions.slice(-MAX_STREAM_ROWS).toReversed();

  return (
    <ScrollView contentContainerStyle={styles.list} testID="insights-content">
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {agent.title ?? agent.provider}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {[agent.model, agent.thinkingOptionId, agent.status].filter(Boolean).join(" · ")}
        </Text>
      </View>

      <View style={styles.grid}>
        <Stat label={t("panels.insights.duration")} value={formatDuration(insights.spanMs)} />
        <Stat
          label={t("panels.insights.toolCalls")}
          value={String(insights.toolCalls)}
          note={
            insights.failedToolCalls > 0
              ? t("panels.insights.failed", { count: insights.failedToolCalls })
              : undefined
          }
        />
        <Stat label={t("panels.insights.tests")} value={String(insights.testRuns)} />
        <Stat
          label={t("panels.insights.jevDecisions")}
          value={String(insights.jevDecisions.length)}
        />
        <Stat
          label={t("panels.insights.jevTime")}
          value={`${insights.jevLatencyMs} ms`}
          note={jevShare > 0 ? `${(jevShare * 100).toFixed(1)}%` : undefined}
        />
        <Stat label={t("panels.insights.compactions")} value={String(insights.compactions)} />
      </View>

      {share !== null && used !== null && max !== null ? (
        <View style={styles.section}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>{t("panels.insights.context")}</Text>
            <Text style={styles.muted}>
              {formatTokens(used)} / {formatTokens(max)}
              {usage?.totalCostUsd ? ` · $${usage.totalCostUsd.toFixed(2)}` : ""}
            </Text>
          </View>
          <View style={styles.track} testID="insights-context-bar">
            <View style={[styles.fill, { width: `${share * 100}%` }]} />
            <View style={[styles.compactionLine, { left: `${COMPACTION_SHARE * 100}%` }]} />
          </View>
        </View>
      ) : null}

      {insights.toolCalls > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("panels.insights.toolKinds")}</Text>
          <View style={styles.chips}>
            {Object.entries(insights.toolCallsByKind)
              .sort((a, b) => b[1] - a[1])
              .map(([kind, count]) => (
                <View key={kind} style={styles.chip}>
                  <Text style={styles.chipValue}>{count}</Text>
                  <Text style={styles.muted}>{kind}</Text>
                </View>
              ))}
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("panels.insights.decisionStream")}</Text>
        {recentDecisions.length === 0 ? (
          <Text style={styles.muted}>{t("panels.insights.noDecisions")}</Text>
        ) : (
          recentDecisions.map((decision) => (
            <DecisionRow
              key={decision.id}
              decision={decision}
              routeLabel={t("panels.insights.route")}
            />
          ))
        )}
      </View>

      <SessionHistorySection serverId={input.serverId} />
    </ScrollView>
  );
}

type HistoryRange = "day" | "week";
const HISTORY_RANGE_MS: Record<HistoryRange, number> = { day: 86_400_000, week: 7 * 86_400_000 };
const MAX_HISTORY_ROWS = 40;

/** Every session of the host in the range, including archived and deleted, by who started it. */
function SessionHistorySection(input: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(input.serverId);
  // COMPAT(agentHistory): added in v0.9.1, remove after 2027-03-29.
  const supported = useSessionStore(
    (state) => state.sessions[input.serverId]?.serverInfo?.features?.agentHistory === true,
  );
  const [range, setRange] = useState<HistoryRange>("day");
  const [entries, setEntries] = useState<AgentHistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!client || !supported) return undefined;
    let cancelled = false;
    setFailed(false);
    client
      .listAgentHistory({ since: new Date(Date.now() - HISTORY_RANGE_MS[range]).toISOString() })
      .then((result) => {
        if (!cancelled) setEntries(result);
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, range, supported]);

  const summaries = useMemo(() => (entries ? summarizeHistory(entries) : []), [entries]);

  let body: React.ReactNode;
  if (!supported)
    body = <Text style={styles.muted}>{t("panels.insights.historyUnsupported")}</Text>;
  else if (failed) body = <Text style={styles.muted}>{t("panels.insights.historyFailed")}</Text>;
  else if (!entries) body = null;
  else if (entries.length === 0)
    body = <Text style={styles.muted}>{t("panels.insights.noSessions")}</Text>;
  else
    body = (
      <>
        {summaries.map((summary) => (
          <View key={summary.group} style={styles.historyGroup} testID="insights-history-group">
            <Text style={styles.decisionChoice} numberOfLines={1}>
              {t(`panels.insights.origins.${summary.group}`)}
            </Text>
            <Text style={styles.muted}>
              {summary.sessions}
              {summary.deleted > 0
                ? ` · ${t("panels.insights.deletedCount", { count: summary.deleted })}`
                : ""}
            </Text>
            <Text style={styles.historyNumber}>{formatTokens(summary.tokens)}</Text>
            <Text style={styles.historyNumber}>${summary.costUsd.toFixed(2)}</Text>
          </View>
        ))}
        {entries.slice(0, MAX_HISTORY_ROWS).map((entry) => (
          <HistoryRow key={entry.agentId} entry={entry} />
        ))}
      </>
    );

  return (
    <View style={styles.section} testID="insights-history">
      <View style={styles.rowBetween}>
        <Text style={styles.sectionTitle}>{t("panels.insights.sessions")}</Text>
        <View style={styles.rangeToggle}>
          {(["day", "week"] as const).map((option) => (
            <RangeButton
              key={option}
              label={t(option === "day" ? "panels.insights.last24h" : "panels.insights.last7d")}
              active={range === option}
              option={option}
              onSelect={setRange}
            />
          ))}
        </View>
      </View>
      {body}
    </View>
  );
}

function RangeButton(input: {
  label: string;
  active: boolean;
  option: HistoryRange;
  onSelect: (option: HistoryRange) => void;
}) {
  const { option, onSelect } = input;
  const handlePress = useMemo(() => () => onSelect(option), [onSelect, option]);
  return (
    <Pressable
      onPress={handlePress}
      style={[styles.rangeButton, input.active && styles.rangeButtonActive]}
      testID={`insights-history-range-${option}`}
    >
      <Text style={input.active ? styles.chipValue : styles.muted}>{input.label}</Text>
    </Pressable>
  );
}

function HistoryRow(input: { entry: AgentHistoryEntry }) {
  const { t } = useTranslation();
  const { entry } = input;
  const when = entry.deletedAt ?? entry.lastActivityAt ?? entry.createdAt;
  const stateLabel = entry.state === "active" ? null : t(`panels.insights.states.${entry.state}`);
  return (
    <View style={styles.historyRow} testID="insights-history-row">
      <View style={styles.historyTitle}>
        <Text style={styles.decisionChoice} numberOfLines={1}>
          {entry.title ?? entry.agentId.slice(0, 8)}
        </Text>
        <Text style={styles.note} numberOfLines={2}>
          {[
            t(`panels.insights.origins.${originGroup(entry.origin)}`),
            entry.model,
            stateLabel,
            formatTimeAgo(new Date(when)),
          ]
            .filter(Boolean)
            .join(" · ")}
          {entry.summary ? `\n${entry.summary}` : ""}
        </Text>
      </View>
      <Text style={styles.historyNumber}>
        {entry.usage ? formatTokens(entryTokens(entry)) : "–"}
      </Text>
      <Text style={styles.historyNumber}>
        {entry.usage ? `$${entry.usage.totalCostUsd.toFixed(2)}` : "–"}
      </Text>
    </View>
  );
}

function Stat(input: { label: string; value: string; note?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.muted} numberOfLines={1}>
        {input.label}
      </Text>
      <Text style={styles.statValue}>{input.value}</Text>
      {input.note ? <Text style={styles.note}>{input.note}</Text> : null}
    </View>
  );
}

function DecisionRow(input: { decision: JevDecision; routeLabel: string }) {
  const { decision } = input;
  return (
    <View style={styles.decision} testID="insights-decision">
      <Text style={styles.decisionQuestion} numberOfLines={1}>
        {decision.question === "route" ? input.routeLabel : decision.question}
      </Text>
      <Text style={styles.decisionChoice} numberOfLines={1}>
        {decision.choice ?? "–"}
      </Text>
      {decision.confidence !== null ? (
        <View style={styles.confidenceTrack}>
          <View style={[styles.fill, { width: `${decision.confidence * 100}%` }]} />
        </View>
      ) : null}
      <Text style={styles.confidenceValue}>
        {decision.confidence !== null ? decision.confidence.toFixed(2) : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { padding: 12, gap: 14 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  header: { gap: 2 },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base, fontWeight: "600" },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  note: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  stat: {
    flexGrow: 1,
    flexBasis: "30%",
    minWidth: 88,
    padding: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    gap: 2,
  },
  statValue: { color: theme.colors.foreground, fontSize: theme.fontSize.lg, fontWeight: "600" },
  section: { gap: 8 },
  sectionTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "600" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: 4, backgroundColor: theme.colors.accent },
  compactionLine: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: theme.colors.destructive,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  rangeToggle: { flexDirection: "row", gap: 4 },
  rangeButton: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  rangeButtonActive: { backgroundColor: theme.colors.surface2 },
  historyGroup: { flexDirection: "row", alignItems: "center", gap: 8 },
  historyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  historyTitle: { flex: 1, gap: 2 },
  historyNumber: {
    width: 56,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  chip: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: theme.colors.surface2,
  },
  chipValue: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "600" },
  decision: { flexDirection: "row", alignItems: "center", gap: 8 },
  decisionQuestion: { width: 84, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  decisionChoice: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  confidenceTrack: {
    width: 48,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  confidenceValue: {
    width: 32,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
