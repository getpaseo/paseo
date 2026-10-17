import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@/components/settings";
import { useAppSettings } from "@/hooks/use-settings";

export function VoiceSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const change = useCallback(
    (voiceWaitingSoundEnabled: boolean) => void updateSettings({ voiceWaitingSoundEnabled }),
    [updateSettings],
  );
  return (
    <SettingsSection title={t("settings.general.voice")}>
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.general.voiceWaitingSound.label")}
          hint={t("settings.general.voiceWaitingSound.description")}
          value={settings.voiceWaitingSoundEnabled}
          onValueChange={change}
          testID="voice-waiting-sound-setting"
        />
      </SettingsCard>
    </SettingsSection>
  );
}
