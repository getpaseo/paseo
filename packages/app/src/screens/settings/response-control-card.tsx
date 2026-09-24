import { useCallback } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useResponseControlSupported } from "@/response-control/use-supported";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

export function ResponseControlCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const supported = useResponseControlSupported(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const result = await patchConfig({ responseControl: enabled });
      if (!result) throw new Error(t("workspace.terminal.hostDisconnected"));
      return result;
    },
  });
  const onValueChange = useCallback((value: boolean) => mutation.mutate(value), [mutation]);
  if (!supported || !connected) return null;
  return (
    <View style={settingsStyles.card} testID="host-page-response-control-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("responseControl.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("responseControl.hint")}</Text>
          {mutation.error ? (
            <Text style={settingsStyles.rowError} testID="response-control-error">
              {mutation.error.message}
            </Text>
          ) : null}
        </View>
        <Switch
          value={config?.responseControl !== false}
          onValueChange={onValueChange}
          disabled={!config || mutation.isPending}
          accessibilityLabel={t("responseControl.title")}
          testID="host-page-response-control-switch"
        />
      </View>
    </View>
  );
}
