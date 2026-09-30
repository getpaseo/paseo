import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { SystemOneUsageBucket } from "@getpaseo/protocol/messages";
import { SettingsCard, SettingsRow, SettingsSwitch } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { MONO_FONT_DATASET } from "@/styles/font-dataset";

const PURPOSES = ["browser", "shadow", "routing", "tool"] as const;
const REFRESH_MS = 30_000;

export function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

interface SystemOneUsageSectionProps {
  serverId: string;
  browserGoals: boolean;
  disabled: boolean;
  onBrowserGoalsChange: (value: boolean) => void;
}

export function SystemOneUsageSection({
  serverId,
  browserGoals,
  disabled,
  onBrowserGoalsChange,
}: SystemOneUsageSectionProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const usageQuery = useFetchQuery({
    queryKey: ["systemOneUsage", serverId],
    enabled: Boolean(client),
    dataShape: "value",
    staleTimeMs: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    queryFn: async () => (await client!.getDaemonConfig()).systemOneUsage ?? null,
  });
  const usage = usageQuery.data;
  const purposes = PURPOSES.filter((purpose) => usage?.last7Days[purpose]);

  return (
    <SettingsSection
      title={t("settings.systemOne.usage.title")}
      info={t("settings.systemOne.usage.info")}
    >
      <SettingsCard testID="host-system-one-usage">
        <SettingsSwitch
          label={t("settings.systemOne.usage.browserGoals.label")}
          hint={t("settings.systemOne.usage.browserGoals.hint")}
          value={browserGoals}
          disabled={disabled}
          onValueChange={onBrowserGoalsChange}
        />
        {purposes.length === 0 ? (
          <SettingsRow
            label={t("settings.systemOne.usage.empty")}
            hint={t("settings.systemOne.usage.emptyHint")}
          />
        ) : (
          purposes.map((purpose) => (
            <SettingsRow
              key={purpose}
              label={t(`settings.systemOne.usage.purposes.${purpose}`)}
              hint={t(`settings.systemOne.usage.purposeHints.${purpose}`)}
            >
              <View style={styles.values}>
                <UsageLine
                  label={t("settings.systemOne.usage.today")}
                  bucket={usage?.today[purpose]}
                />
                <UsageLine
                  label={t("settings.systemOne.usage.week")}
                  bucket={usage?.last7Days[purpose]}
                />
              </View>
            </SettingsRow>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function UsageLine({ label, bucket }: { label: string; bucket: SystemOneUsageBucket | undefined }) {
  const { t } = useTranslation();
  const calls = bucket?.calls ?? 0;
  const tokens = (bucket?.inputTokens ?? 0) + (bucket?.outputTokens ?? 0);
  return (
    <View style={styles.line}>
      <Text style={settingsStyles.rowHint}>{label}</Text>
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
}));
