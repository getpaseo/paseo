import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@/components/settings";
import { useAppSettings } from "@/hooks/use-settings";

export function BackgroundConnectionSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const changeBackgroundConnection = useCallback(
    (backgroundConnectionEnabled: boolean) => void updateSettings({ backgroundConnectionEnabled }),
    [updateSettings],
  );

  return (
    <SettingsSection title={t("settings.general.backgroundConnection.section")}>
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.general.backgroundConnection.label")}
          hint={t("settings.general.backgroundConnection.description")}
          value={settings.backgroundConnectionEnabled}
          onValueChange={changeBackgroundConnection}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
