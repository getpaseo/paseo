import { useCallback, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SettingsInfoTip, SettingsRow } from "@/components/settings";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";

// Host-wide, persisted, and applied live by the daemon.
export function IdleRuntimeCleanupRow({ serverId }: { serverId: string }) {
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

  const infoTip = useMemo(
    () => (
      <SettingsInfoTip
        title={t("settings.host.agents.idleRuntimeCleanup.title")}
        info={t("settings.host.agents.idleRuntimeCleanup.info")}
      />
    ),
    [t],
  );

  if (!isConnected || !isSupported || !config) return null;

  return (
    <SettingsRow
      label={t("settings.host.agents.idleRuntimeCleanup.title")}
      labelAccessory={infoTip}
      hint={t("settings.host.agents.idleRuntimeCleanup.hint")}
      error={mutation.error?.message}
      errorTestID="host-page-idle-runtime-cleanup-error"
      testID="host-page-idle-runtime-cleanup-card"
    >
      <Switch
        value={config.idleRuntimeCleanup !== false}
        onValueChange={handleValueChange}
        disabled={mutation.isPending}
        accessibilityLabel={t("settings.host.agents.idleRuntimeCleanup.title")}
        testID="host-page-idle-runtime-cleanup-switch"
      />
    </SettingsRow>
  );
}
