import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "@/components/settings";
import { FormTextInput } from "@/components/ui/form-field";
import { parseTerminalScrollbackLines, useAppSettings } from "@/hooks/use-settings";
import { settingsStyles } from "@/styles/settings";

export function TerminalSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const [scrollbackValue, setScrollbackValue] = useState(String(settings.terminalScrollbackLines));

  const handleChangeText = useCallback((value: string) => {
    setScrollbackValue(value.replace(/[^\d]/g, ""));
  }, []);

  const commitScrollback = useCallback(() => {
    const nextValue =
      parseTerminalScrollbackLines(scrollbackValue) ?? settings.terminalScrollbackLines;
    setScrollbackValue(String(nextValue));
    if (nextValue !== settings.terminalScrollbackLines) {
      void updateSettings({ terminalScrollbackLines: nextValue });
    }
  }, [scrollbackValue, settings.terminalScrollbackLines, updateSettings]);

  useEffect(() => {
    setScrollbackValue(String(settings.terminalScrollbackLines));
  }, [settings.terminalScrollbackLines]);

  return (
    <SettingsSection title={t("settings.sections.terminal")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.general.terminalScrollback.label")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.general.terminalScrollback.description")}
            </Text>
          </View>
          <FormTextInput
            size="sm"
            initialValue={scrollbackValue}
            onChangeText={handleChangeText}
            onBlur={commitScrollback}
            onSubmitEditing={commitScrollback}
            keyboardType="number-pad"
            inputMode="numeric"
            selectTextOnFocus
            style={styles.scrollbackInput}
            accessibilityLabel={t("settings.general.terminalScrollback.accessibilityLabel")}
          />
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  scrollbackInput: {
    width: 112,
    textAlign: "right",
  },
});
