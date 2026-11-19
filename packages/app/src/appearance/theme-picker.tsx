import { AppearanceText as Text } from "@/appearance/text";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { DEFAULT_THEME_PREFERENCE, useAppSettings, type AppSettings } from "@/hooks/use-settings";
import type { PluginThemeOption } from "@/plugins/themes";
import { THEME_OPTIONS, PLUGIN_THEME_PREFERENCE, type Theme } from "@/styles/theme";
import { useContributedThemes } from "./provider";
import { SystemThemePreview, ThemePreview, ThemePreviewFrame } from "./theme-preview";

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
    />
  );
}

function PluginThemeTile({
  option,
  selected,
  onSelect,
}: {
  option: PluginThemeOption;
  selected: boolean;
  onSelect: (option: PluginThemeOption) => void;
}) {
  const handlePress = useCallback(() => onSelect(option), [onSelect, option]);
  return (
    <ThemeTile
      label={option.name}
      selected={selected}
      onPress={handlePress}
      previewTheme={option.theme}
    />
  );
}

function ThemeTile({
  label,
  selected,
  onPress,
  previewTheme,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** "system" follows the OS, so its preview shows both halves. */
  previewTheme: Theme | "system";
}) {
  const accessibilityState = useMemo(() => ({ checked: selected }), [selected]);
  const tileStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.tile,
      hovered && !selected && styles.tileHovered,
      selected && styles.tileSelected,
    ],
    [selected],
  );
  return (
    <View style={styles.cell}>
      <PressHighlight
        style={tileStyle}
        onPress={onPress}
        accessibilityRole="radio"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        aria-checked={selected}
      >
        <ThemePreviewFrame>
          {previewTheme === "system" ? (
            <SystemThemePreview />
          ) : (
            <ThemePreview theme={previewTheme} />
          )}
        </ThemePreviewFrame>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </PressHighlight>
    </View>
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
  cell: {
    width: { xs: "50%", md: "25%" },
    padding: theme.spacing[3] / 2,
  },
  tile: {
    padding: theme.spacing[1],
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[2],
    borderColor: "transparent",
  },
  tileHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tileSelected: {
    borderColor: theme.colors.accent,
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[1],
  },
}));
