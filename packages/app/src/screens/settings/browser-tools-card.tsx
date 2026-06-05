import { useCallback } from "react";
import { Text, View } from "react-native";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { createBrowserToolsPatch, getBrowserToolsCardState } from "./browser-tools-config";

export function BrowserToolsOptInCard({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const state = getBrowserToolsCardState({ isConnected, config });

  const handleValueChange = useCallback(
    (next: boolean) => {
      void patchConfig(createBrowserToolsPatch(next));
    },
    [patchConfig],
  );

  if (!state.isVisible) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-browser-tools-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{state.title}</Text>
          <Text style={settingsStyles.rowHint}>{state.warning}</Text>
        </View>
        <Switch
          value={state.isEnabled}
          onValueChange={handleValueChange}
          accessibilityLabel="Enable browser tools"
          testID="host-page-browser-tools-switch"
        />
      </View>
    </View>
  );
}
