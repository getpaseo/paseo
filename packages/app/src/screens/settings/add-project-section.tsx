import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { pickDirectory } from "@/desktop/pick-directory";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";

/** Where Browse in Add Project opens. Desktop only: browsing uses the native folder picker. */
export function AddProjectSection() {
  const { t } = useTranslation();
  const { settings, isSaving, updateSettings } = useDesktopSettings();
  const [pickFailed, setPickFailed] = useState(false);
  const { defaultBrowseDirectory, lastBrowseDirectory } = settings.projects;

  const saveDefaultBrowseDirectory = useCallback(
    (directory: string | null) => {
      void updateSettings({ projects: { defaultBrowseDirectory: directory } }).catch(() => {
        // useDesktopSettings owns the user-visible IPC error.
      });
    },
    [updateSettings],
  );

  const choose = useCallback(async () => {
    setPickFailed(false);
    try {
      const directory = await pickDirectory({
        defaultPath: defaultBrowseDirectory ?? lastBrowseDirectory,
      });
      if (directory) saveDefaultBrowseDirectory(directory);
    } catch {
      setPickFailed(true);
    }
  }, [defaultBrowseDirectory, lastBrowseDirectory, saveDefaultBrowseDirectory]);

  const handleChoosePress = useCallback(() => {
    void choose();
  }, [choose]);

  const handleResetPress = useCallback(() => {
    saveDefaultBrowseDirectory(null);
  }, [saveDefaultBrowseDirectory]);

  return (
    <SettingsSection title={t("settings.general.addProject.title")}>
      <SettingsCard>
        <SettingsRow
          label={t("settings.general.addProject.browseStart")}
          hint={defaultBrowseDirectory ?? t("settings.general.addProject.browseStartLastUsed")}
          error={pickFailed ? t("settings.general.addProject.chooseFailed") : undefined}
          testID="add-project-browse-start-row"
        >
          <View style={styles.controls}>
            {defaultBrowseDirectory ? (
              <Button variant="ghost" size="sm" onPress={handleResetPress} disabled={isSaving}>
                {t("settings.general.addProject.reset")}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onPress={handleChoosePress} disabled={isSaving}>
              {t("settings.general.addProject.choose")}
            </Button>
          </View>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
