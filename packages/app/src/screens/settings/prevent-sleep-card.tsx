import { useCallback } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import {
  useSleepPreventionSupported,
  useSupportsSleepPreventionProtocol,
} from "@/hooks/use-sleep-prevention";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

function formatMutationError(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

export function PreventSleepCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsFeature = useSupportsSleepPreventionProtocol(serverId);
  const isSupportedHost = useSleepPreventionSupported(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);

  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      const result = await patchConfig({ preventSleepWhileAgentsRun: next });
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

  if (!isConnected || !supportsFeature || config === null) return null;

  const errorText = formatMutationError(mutation.error);

  return (
    <View style={settingsStyles.card} testID="host-page-prevent-sleep-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.preventSleep.title")}</Text>
          <Text style={settingsStyles.rowHint}>
            {isSupportedHost
              ? t("settings.host.preventSleep.hint")
              : t("settings.host.preventSleep.unsupported")}
          </Text>
          {errorText ? (
            <Text style={settingsStyles.rowError} testID="host-page-prevent-sleep-error">
              {errorText}
            </Text>
          ) : null}
        </View>
        <Switch
          value={config.preventSleepWhileAgentsRun !== false}
          onValueChange={handleValueChange}
          disabled={!isSupportedHost || mutation.isPending}
          accessibilityLabel={t("settings.host.preventSleep.title")}
          testID="host-page-prevent-sleep-switch"
        />
      </View>
    </View>
  );
}
