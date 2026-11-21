import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@/components/settings";
import { useAppSettings } from "@/hooks/use-settings";

export function AddProjectSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const changeStartsOnDirectorySearch = useCallback(
    (addProjectStartsOnDirectorySearch: boolean) =>
      void updateSettings({ addProjectStartsOnDirectorySearch }),
    [updateSettings],
  );
  return (
    <SettingsSection title={t("settings.general.addProject.title")}>
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.general.addProject.startOnDirectorySearch.label")}
          hint={t("settings.general.addProject.startOnDirectorySearch.description")}
          value={settings.addProjectStartsOnDirectorySearch}
          onValueChange={changeStartsOnDirectorySearch}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
