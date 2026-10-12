import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SettingsSection, SettingsCard, SettingsSelect, SettingsRow } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { useAppSettings } from "@/hooks/use-settings";
import type { FileOpenMode } from "./types";

export function FileOpeningSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const options = useMemo(
    () =>
      (["smart", "preview", "external", "ask"] as const).map((value) => ({
        value,
        label: t(`fileAccess.${value}`),
      })),
    [t],
  );
  const change = useCallback(
    (mode: FileOpenMode) => {
      void updateSettings((current) => ({ fileOpening: { ...current.fileOpening, mode } }));
    },
    [updateSettings],
  );
  const reset = useCallback(() => {
    void updateSettings((current) => ({
      fileOpening: { ...current.fileOpening, byExtension: {} },
    }));
  }, [updateSettings]);
  return (
    <SettingsSection title={t("fileAccess.settingsTitle")}>
      <SettingsCard>
        <SettingsSelect
          label={t("fileAccess.defaultMode")}
          value={settings.fileOpening.mode}
          options={options}
          onValueChange={change}
        />
        <SettingsRow label={t("fileAccess.reset")} hint={t("fileAccess.preferencesHint")}>
          <Button variant="outline" size="sm" onPress={reset} testID="reset-file-opening">
            {t("fileAccess.reset")}
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
