import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentHistoryEntry, SystemOneUsageBucket } from "@getpaseo/protocol/messages";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useFetchQuery } from "@/data/query";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { MONO_FONT_DATASET } from "@/styles/font-dataset";
import { resolveProviderLabel } from "@/utils/provider-definitions";

const WINDOW_DAYS = 7;
const HISTORY_LIMIT = 2000;
const REFRESH_MS = 60_000;
const JEV_PURPOSES = ["browser", "shadow", "routing", "tool"] as const;

export interface ProviderTokenRow {
  provider: string;
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Sessions active in the window, summed per provider; usage is each session's lifetime total. */
export function aggregateProviderTokens(
  entries: readonly AgentHistoryEntry[],
  sinceMs: number,
): ProviderTokenRow[] {
  const rows = new Map<string, ProviderTokenRow>();
  for (const entry of entries) {
    const activeAt = Date.parse(entry.lastActivityAt ?? entry.createdAt);
    if (!entry.usage || !(activeAt >= sinceMs)) continue;
    const row = rows.get(entry.provider) ?? {
      provider: entry.provider,
      sessions: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    row.sessions += 1;
    row.turns += entry.usage.turns;
    row.inputTokens += entry.usage.inputTokens + entry.usage.cachedInputTokens;
    row.outputTokens += entry.usage.outputTokens;
    row.costUsd += entry.usage.totalCostUsd;
    rows.set(entry.provider, row);
  }
  return [...rows.values()].sort(
    (left, right) =>
      right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens),
  );
}

function windowStartMs(): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (WINDOW_DAYS - 1));
  return start.getTime();
}

/** Tokens and cost next to the plan quotas: agents per provider, then Jev per purpose. */
export function TokenUsageSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const hasHistory = useHostFeature(serverId, "agentHistory");
  const hasJev = useHostFeature(serverId, "systemOneUsage");
  const { entries: snapshotEntries } = useProvidersSnapshot(serverId);

  const agentsQuery = useFetchQuery({
    queryKey: ["tokenUsage", "agents", serverId],
    enabled: Boolean(client && hasHistory),
    dataShape: "list",
    staleTimeMs: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const sinceMs = windowStartMs();
      const entries = await client!.listAgentHistory({
        since: new Date(sinceMs).toISOString(),
        limit: HISTORY_LIMIT,
        includeInternal: true,
      });
      return aggregateProviderTokens(entries, sinceMs);
    },
  });
  const jevQuery = useFetchQuery({
    queryKey: ["systemOneUsage", serverId],
    enabled: Boolean(client && hasJev),
    dataShape: "value",
    staleTimeMs: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    queryFn: async () => (await client!.getDaemonConfig()).systemOneUsage ?? null,
  });

  if (!hasHistory && !hasJev) return null;
  const providers = agentsQuery.data ?? [];
  const jev = jevQuery.data;
  const jevPurposes = JEV_PURPOSES.filter((purpose) => jev?.last7Days[purpose]);

  return (
    <SettingsSection
      title={t("settings.tokenUsage.title")}
      info={t("settings.tokenUsage.info")}
      testID="host-token-usage"
    >
      <SettingsCard>
        {providers.map((row) => (
          <SettingsRow
            key={row.provider}
            label={resolveProviderLabel(row.provider, snapshotEntries)}
            hint={t("settings.tokenUsage.sessions", { count: row.sessions, turns: row.turns })}
          >
            <View style={styles.values}>
              <Text style={styles.number} dataSet={MONO_FONT_DATASET}>
                {t("settings.tokenUsage.tokens", {
                  input: formatTokenCount(row.inputTokens),
                  output: formatTokenCount(row.outputTokens),
                })}
              </Text>
              {row.costUsd > 0 ? (
                <Text style={styles.muted} dataSet={MONO_FONT_DATASET}>
                  {`$${row.costUsd.toFixed(2)}`}
                </Text>
              ) : null}
            </View>
          </SettingsRow>
        ))}
        {jevPurposes.map((purpose) => (
          <SettingsRow
            key={`jev-${purpose}`}
            label={`Jev · ${t(`settings.systemOne.usage.purposes.${purpose}`)}`}
            hint={t(`settings.systemOne.usage.purposeHints.${purpose}`)}
          >
            <View style={styles.values}>
              <JevLine label={t("settings.systemOne.usage.today")} bucket={jev?.today[purpose]} />
              <JevLine
                label={t("settings.systemOne.usage.week")}
                bucket={jev?.last7Days[purpose]}
              />
            </View>
          </SettingsRow>
        ))}
        {providers.length === 0 && jevPurposes.length === 0 ? (
          <SettingsRow
            label={t("settings.tokenUsage.empty")}
            hint={t("settings.tokenUsage.emptyHint")}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function JevLine({ label, bucket }: { label: string; bucket: SystemOneUsageBucket | undefined }) {
  const { t } = useTranslation();
  const calls = bucket?.calls ?? 0;
  const tokens = (bucket?.inputTokens ?? 0) + (bucket?.outputTokens ?? 0);
  return (
    <View style={styles.line}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.number} dataSet={MONO_FONT_DATASET}>
        {t("settings.systemOne.usage.summary", { count: calls, tokens: formatTokenCount(tokens) })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  values: {
    alignItems: "flex-end",
    gap: theme.spacing[1],
  },
  line: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  number: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
