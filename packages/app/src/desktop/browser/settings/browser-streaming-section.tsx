import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSelect } from "@/components/settings";
import { useAppSettings, type AppSettings } from "@/hooks/use-settings";

type Quality = AppSettings["browserStreamQuality"];
type ScrollSpeed = AppSettings["browserScrollSpeed"];

const SCROLL_SPEEDS: ScrollSpeed[] = ["0.5", "1", "1.5", "2", "3"];

export function BrowserStreamingSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const setQuality = useCallback(
    (browserStreamQuality: Quality) => void updateSettings({ browserStreamQuality }),
    [updateSettings],
  );
  const setScrollSpeed = useCallback(
    (browserScrollSpeed: ScrollSpeed) => void updateSettings({ browserScrollSpeed }),
    [updateSettings],
  );
  return (
    <SettingsCard testID="browser-streaming-settings">
      <SettingsSelect<Quality>
        label={t("settings.browser.streaming.quality.label")}
        hint={t(`settings.browser.streaming.quality.hints.${settings.browserStreamQuality}`)}
        value={settings.browserStreamQuality}
        options={[
          { value: "smooth", label: t("settings.browser.streaming.quality.options.smooth") },
          { value: "sharp", label: t("settings.browser.streaming.quality.options.sharp") },
          { value: "saver", label: t("settings.browser.streaming.quality.options.saver") },
        ]}
        onValueChange={setQuality}
      />
      <SettingsSelect<ScrollSpeed>
        label={t("settings.browser.streaming.scrollSpeed.label")}
        hint={t("settings.browser.streaming.scrollSpeed.hint")}
        value={settings.browserScrollSpeed}
        options={SCROLL_SPEEDS.map((speed) => ({ value: speed, label: `${speed}×` }))}
        onValueChange={setScrollSpeed}
      />
    </SettingsCard>
  );
}
