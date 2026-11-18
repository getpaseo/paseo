import { useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ScrubNumberField } from "@/components/goals/scrub-number-field";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import {
  GOAL_RUN_CAP_DEFAULT,
  GOAL_RUN_CAP_FIELD,
  goalRunCapOf,
  goalRunCapPatch,
} from "@/goals/goal-run-cap";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

/**
 * `daemon.goals.maxConcurrentRuns`: worker runs across every goal on the host. Persisted and
 * applied live by the daemon. A drag moves the draft; Save sends it once.
 */
export function GoalRunCapSection({ serverId }: { serverId: string }): ReactElement | null {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useHostFeature(serverId, "goalConcurrencyConfig");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const saved = goalRunCapOf(config);
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? saved;
  const patch = goalRunCapPatch(config, value);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!patch) return null;
      const result = await patchConfig(patch);
      if (!result) throw new Error(t("workspace.terminal.hostDisconnected"));
      return result;
    },
    onSuccess: () => setDraft(null),
  });

  const handleChange = useCallback((next: number | null) => {
    if (next !== null) setDraft(next);
  }, []);
  const handleSave = useCallback(() => mutation.mutate(), [mutation]);

  if (!isConnected || !isSupported || !config) return null;

  const title = t("settings.host.goalRunCap.title");
  return (
    <SettingsSection title={t("settings.host.goalRunCap.sectionTitle")}>
      <View style={settingsStyles.card} testID="host-page-goal-run-cap-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{title}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.host.goalRunCap.hint")}</Text>
            {mutation.error ? (
              <Text style={settingsStyles.rowError} testID="host-page-goal-run-cap-error">
                {mutation.error.message}
              </Text>
            ) : null}
          </View>
        </View>
        <View style={styles.controls}>
          <View style={styles.field}>
            <ScrubNumberField
              label={title}
              value={value}
              onChange={handleChange}
              scale={GOAL_RUN_CAP_FIELD.scale}
              format={GOAL_RUN_CAP_FIELD.format}
              inputMode={GOAL_RUN_CAP_FIELD.inputMode}
              disabled={mutation.isPending}
              size="sm"
              testID="host-page-goal-run-cap"
            />
          </View>
          <Text style={styles.unit}>{t("settings.host.goalRunCap.unit")}</Text>
          <Text style={styles.unit}>
            {t("settings.host.goalRunCap.defaultValue", { value: GOAL_RUN_CAP_DEFAULT })}
          </Text>
          <View style={styles.spacer} />
          <Button
            variant="secondary"
            size="sm"
            onPress={handleSave}
            disabled={!patch || mutation.isPending}
            testID="host-page-goal-run-cap-save"
          >
            {mutation.isPending
              ? t("settings.host.goalRunCap.saving")
              : t("settings.host.goalRunCap.save")}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  field: {
    width: 120,
  },
  unit: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  spacer: {
    flexGrow: 1,
  },
}));
