import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { BrowserDataSection } from "@/desktop/browser/settings/browser-data-section";
import { DEFAULT_BROWSER_URL, parseBrowserHomeUrl } from "@/desktop/browser/store";
import { useAppSettings } from "@/hooks/use-settings";
import { settingsStyles } from "@/styles/settings";

export function BrowserSettingsSection() {
  return (
    <View>
      <BrowserHomePageSection />
      <BrowserDataSection />
    </View>
  );
}

function BrowserHomePageSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const homeUrl = settings.browserHomeUrl;
  // The field is uncontrolled, so a saved URL is written into it directly.
  const input = useRef<EditingTextInputHandle>(null);
  const [isInvalid, setIsInvalid] = useState(false);

  useEffect(() => {
    input.current?.replaceText(homeUrl);
  }, [homeUrl]);

  const clearError = useCallback(() => {
    setIsInvalid(false);
  }, []);

  const commit = useCallback(() => {
    const next = parseBrowserHomeUrl(input.current?.getText());
    // Keep the typed text so it can be corrected; the saved URL stays in effect.
    if (next === null) {
      setIsInvalid(true);
      return;
    }
    setIsInvalid(false);
    input.current?.replaceText(next);
    if (next !== homeUrl) {
      void updateSettings({ browserHomeUrl: next });
    }
  }, [homeUrl, updateSettings]);

  return (
    <SettingsSection title={t("settings.general.browserHomePage.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.general.browserHomePage.label")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.general.browserHomePage.description")}
            </Text>
            {isInvalid ? (
              <Text style={settingsStyles.rowError}>
                {t("settings.general.browserHomePage.invalid")}
              </Text>
            ) : null}
          </View>
          <FormTextInput
            ref={input}
            initialValue={homeUrl}
            onChangeText={clearError}
            onBlur={commit}
            onSubmitEditing={commit}
            placeholder={DEFAULT_BROWSER_URL}
            keyboardType="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={styles.urlInput}
            accessibilityLabel={t("settings.general.browserHomePage.accessibilityLabel")}
          />
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  urlInput: {
    flexGrow: 1,
    flexShrink: 1,
    maxWidth: 280,
  },
});
