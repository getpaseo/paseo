import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Switch } from "@/components/ui/switch";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";

export function DesktopPowerSection() {
  const { t } = useTranslation();
  const { settings, isSaving, updateSettings } = useDesktopSettings();

  const handleKeepAwakeChange = useCallback(
    (keepAwakeWhileAgentsRunning: boolean) => {
      void updateSettings({ power: { keepAwakeWhileAgentsRunning } }).catch(() => {
        // useDesktopSettings owns the user-visible IPC error.
      });
    },
    [updateSettings],
  );

  return (
    <SettingsSection title={t("settings.power.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.power.keepAwake")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.power.keepAwakeHint")}</Text>
          </View>
          <Switch
            value={settings.power.keepAwakeWhileAgentsRunning}
            onValueChange={handleKeepAwakeChange}
            disabled={isSaving}
            accessibilityLabel={t("settings.power.keepAwake")}
            testID="desktop-power-keep-awake-switch"
          />
        </View>
      </View>
    </SettingsSection>
  );
}
