import React, { useCallback } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { createBrowserToolsPatch, getBrowserToolsCardState } from "./browser-tools-config";
import { toErrorMessage } from "@/utils/error-messages";

export function BrowserToolsOptInCard({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const state = getBrowserToolsCardState({ isConnected, config });
  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      const result = await patchConfig(createBrowserToolsPatch(next));
      if (!result) {
        throw new Error("Host is not connected");
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

  if (!state.isVisible) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-browser-tools-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{state.title}</Text>
          <Text style={settingsStyles.rowHint}>{state.warning}</Text>
          {mutation.isPending ? (
            <Text style={settingsStyles.rowHint} testID="host-page-browser-tools-loading">
              Updating browser tools…
            </Text>
          ) : null}
          {mutation.error ? (
            <Text style={settingsStyles.rowError} testID="host-page-browser-tools-error">
              {toErrorMessage(mutation.error)}
            </Text>
          ) : null}
        </View>
        <Switch
          value={state.isEnabled}
          onValueChange={handleValueChange}
          disabled={mutation.isPending}
          accessibilityLabel="Enable browser tools"
          testID="host-page-browser-tools-switch"
        />
      </View>
    </View>
  );
}
