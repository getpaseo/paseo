import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DEFAULT_THEME_PREFERENCE, useAppSettings, type AppSettings } from "@/hooks/use-settings";
import { THEME_OPTIONS, PLUGIN_THEME_PREFERENCE } from "@/styles/theme";
import { useContributedThemes } from "./provider";
import { PluginThemeTile, ThemeTile } from "./theme-tile";

type BuiltInThemePreference = Exclude<AppSettings["theme"], typeof PLUGIN_THEME_PREFERENCE>;

// System leads the grid because it is the default.
const PICKER_THEME_OPTIONS = [
  ...THEME_OPTIONS.filter((option) => option.name === "auto"),
  ...THEME_OPTIONS.filter((option) => option.name !== "auto"),
];

/**
 * Every theme as a tile with a small preview drawn from its own tokens. Picking a tile applies
 * the theme to the whole app at once. Settings → Appearance and first-run setup share it.
 */
export function ThemePicker() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const { options: pluginThemes, selected: selectedPluginTheme, select } = useContributedThemes();
  // A selected contribution that is no longer installed shows the fallback the app renders.
  const builtInValue =
    settings.theme === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : settings.theme;

  const selectBuiltIn = useCallback(
    (theme: BuiltInThemePreference) => {
      void updateSettings({ theme });
    },
    [updateSettings],
  );

  return (
    <View
      style={styles.grid}
      accessibilityRole="radiogroup"
      accessibilityLabel={t("settings.appearance.theme.title")}
    >
      {PICKER_THEME_OPTIONS.map((option) => (
        <BuiltInThemeTile
          key={option.name}
          value={option.name}
          selected={selectedPluginTheme === null && builtInValue === option.name}
          onSelect={selectBuiltIn}
        />
      ))}
      {pluginThemes.map((option) => (
        <PluginThemeTile
          key={option.id}
          option={option}
          selected={selectedPluginTheme?.id === option.id}
          onSelect={select}
        />
      ))}
    </View>
  );
}

function BuiltInThemeTile({
  value,
  selected,
  onSelect,
}: {
  value: BuiltInThemePreference;
  selected: boolean;
  onSelect: (value: BuiltInThemePreference) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  const option = THEME_OPTIONS.find((candidate) => candidate.name === value);
  return (
    <ThemeTile
      label={t(`settings.appearance.theme.options.${value}`)}
      selected={selected}
      onPress={handlePress}
      previewTheme={option && "theme" in option ? option.theme : "system"}
      swatch={option && "swatch" in option ? option.swatch : undefined}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  // Columns fill the row: each cell is a fixed fraction of it, and the half-gap padding on every
  // cell plus the negative margin here leaves exactly one gap between neighbors.
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    margin: -theme.spacing[3] / 2,
  },
}));
