import React, { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/settings";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import {
  createBrowserToolsPatch,
  getBrowserToolsCardState,
  getBrowserToolsMutationViewState,
} from "./browser-tools-config";

export function BrowserToolsRow({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const state = getBrowserToolsCardState({ isConnected, config });
  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      const result = await patchConfig(createBrowserToolsPatch(next));
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return result;
    },
  });
  const mutationView = getBrowserToolsMutationViewState({
    isPending: mutation.isPending,
    error: mutation.error,
  });

  const handleValueChange = useCallback(
    (next: boolean) => {
      mutation.mutate(next);
    },
    [mutation],
  );

  const hint = useMemo(
    () => (
      <View>
        <Text style={settingsStyles.rowHint}>{state.warning}</Text>
        {mutationView.loadingText ? (
          <Text style={settingsStyles.rowHint} testID="host-page-browser-tools-loading">
            {mutationView.loadingText}
          </Text>
        ) : null}
      </View>
    ),
    [mutationView.loadingText, state.warning],
  );

  if (!state.isVisible) return null;

  return (
    <SettingsRow
      label={state.title}
      hint={hint}
      error={mutationView.errorText ?? undefined}
      testID="host-page-browser-tools-card"
    >
      <Switch
        value={state.isEnabled}
        onValueChange={handleValueChange}
        disabled={mutationView.isSwitchDisabled}
        accessibilityLabel="Enable browser tools"
        testID="host-page-browser-tools-switch"
      />
    </SettingsRow>
  );
}
