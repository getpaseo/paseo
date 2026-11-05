import { useCallback } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsInfoTip } from "@/components/settings/headings/settings-info-tip";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

// Host-wide, persisted, and applied live by the daemon.
export function IdleRuntimeCleanupCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useHostFeature(serverId, "idleRuntimeCleanupSetting");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      const result = await patchConfig({ idleRuntimeCleanup: next });
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return result;
    },
  });

  const handleValueChange = useCallback(
    (next: boolean) => {
      mutation.mutate(next);
    },
    [mutation],
  );

  if (!isConnected || !isSupported || !config) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-idle-runtime-cleanup-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <View style={styles.titleRow}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.agents.idleRuntimeCleanup.title")}
            </Text>
            <SettingsInfoTip
              title={t("settings.host.agents.idleRuntimeCleanup.title")}
              info={t("settings.host.agents.idleRuntimeCleanup.info")}
            />
          </View>
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.agents.idleRuntimeCleanup.hint")}
          </Text>
          {mutation.error ? (
            <Text style={settingsStyles.rowError} testID="host-page-idle-runtime-cleanup-error">
              {mutation.error.message}
            </Text>
          ) : null}
        </View>
        <Switch
          value={config.idleRuntimeCleanup !== false}
          onValueChange={handleValueChange}
          disabled={mutation.isPending}
          accessibilityLabel={t("settings.host.agents.idleRuntimeCleanup.title")}
          testID="host-page-idle-runtime-cleanup-switch"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
