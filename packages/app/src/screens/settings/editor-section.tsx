import { Switch, Text, View } from "react-native";
import { useCallback } from "react";
import { useAppSettings } from "@/hooks/use-settings";
import { SettingsSection } from "./settings-section";
import { settingsStyles } from "@/styles/settings";

export function EditorSection() {
  const { settings, updateSettings } = useAppSettings();
  const handleChange = useCallback(
    (vimKeybindings: boolean) => void updateSettings({ vimKeybindings }),
    [updateSettings],
  );
  return (
    <SettingsSection title="Editor">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Vim keybindings</Text>
            <Text style={settingsStyles.rowHint}>Applies to source files on web and desktop.</Text>
          </View>
          <Switch
            value={settings.vimKeybindings}
            onValueChange={handleChange}
            accessibilityLabel="Vim keybindings"
            testID="vim-keybindings-toggle"
          />
        </View>
      </View>
    </SettingsSection>
  );
}
