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
  const { t: browserToolsT } = useTranslation("browserTools");
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
        <Text style={settingsStyles.rowHint}>{browserToolsT("description")}</Text>
        {mutationView.loadingText ? (
          <Text style={settingsStyles.rowHint} testID="host-page-browser-tools-loading">
            {browserToolsT("updating")}
          </Text>
        ) : null}
      </View>
    ),
    [browserToolsT, mutationView.loadingText],
  );

  if (!state.isVisible) return null;

  return (
    <SettingsRow
      label={browserToolsT("title")}
      hint={hint}
      error={mutationView.errorText ?? undefined}
      errorTestID="host-page-browser-tools-error"
      testID="host-page-browser-tools-card"
    >
      <Switch
        value={state.isEnabled}
        onValueChange={handleValueChange}
        disabled={mutationView.isSwitchDisabled}
        accessibilityLabel={browserToolsT("enable")}
        testID="host-page-browser-tools-switch"
      />
    </SettingsRow>
  );
}
