import { AppearanceText as Text } from "@/appearance/text";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { settingsStyles } from "@/styles/settings";
import { DEFAULT_THEME_PREFERENCE, useAppSettings, type AppSettings } from "@/hooks/use-settings";
import type { PluginThemeOption } from "@/plugins/themes";
import {
  THEME_OPTIONS,
  DARK_THEME_OPTIONS,
  PLUGIN_THEME_PREFERENCE,
  darkTheme,
  lightTheme,
  type DarkThemePreference,
  type Theme,
} from "@/styles/theme";
import { useContributedThemes } from "./provider";

type BuiltInThemePreference = Exclude<AppSettings["theme"], typeof PLUGIN_THEME_PREFERENCE>;

// System leads the grid because it is the default.
const PICKER_THEME_OPTIONS = [
  ...THEME_OPTIONS.filter((option) => option.name === "auto"),
  ...THEME_OPTIONS.filter((option) => option.name !== "auto"),
];

const PREVIEW_ASPECT_RATIO = 16 / 9;

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
  const selectPreferredDark = useCallback(
    (preferredDarkTheme: DarkThemePreference) => {
      void updateSettings({ preferredDarkTheme });
    },
    [updateSettings],
  );

  return (
    <View>
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
      {settings.theme === "auto" ? (
        <PreferredDarkThemeRow value={settings.preferredDarkTheme} onChange={selectPreferredDark} />
      ) : null}
    </View>
  );
}

export function PreferredDarkThemeRow({
  value,
  onChange,
}: {
  value: DarkThemePreference;
  onChange: (value: DarkThemePreference) => void;
}) {
  const { t } = useTranslation();
  const selectedLabel = t(`settings.appearance.theme.options.${value}`);
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.appearance.theme.preferredDarkTitle")}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.appearance.theme.preferredDarkHint")}
        </Text>
      </View>
      <DropdownMenu>
        <DropdownTrigger
          accessibilityLabel={t("settings.appearance.theme.preferredDarkAccessibility", {
            value: selectedLabel,
          })}
        >
          {selectedLabel}
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={220}>
          {DARK_THEME_OPTIONS.map((option) => (
            <PreferredDarkThemeOption
              key={option.name}
              value={option.name}
              selected={value === option.name}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function PreferredDarkThemeOption({
  value,
  selected,
  onChange,
}: {
  value: DarkThemePreference;
  selected: boolean;
  onChange: (value: DarkThemePreference) => void;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(value), [onChange, value]);
  return (
    <DropdownMenuItem
      selected={selected}
      onSelect={handleSelect}
      testID={`preferred-dark-theme-option-${value}`}
    >
      {t(`settings.appearance.theme.options.${value}`)}
    </DropdownMenuItem>
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
        <View style={styles.previewFrame}>
          {previewTheme === "system" ? (
            <SystemThemePreview />
          ) : (
            <ThemePreview theme={previewTheme} />
          )}
        </View>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </PressHighlight>
    </View>
  );
}

/** A sketch of the app — sidebar, a few lines of text and an accent bubble — in `theme`'s colors. */
function ThemePreview({ theme }: { theme: Theme }) {
  const colors = theme.colors;
  const previewStyles = useMemo(
    () => ({
      root: [styles.preview, { backgroundColor: colors.surface0 }],
      sidebar: [styles.previewSidebar, { backgroundColor: colors.surfaceSidebar }],
      mutedLine: { backgroundColor: colors.foregroundMuted },
      strongLine: { backgroundColor: colors.foreground },
      bubble: [styles.previewBubble, { backgroundColor: colors.accent }],
    }),
    [colors],
  );
  return (
    <View style={previewStyles.root}>
      <View style={previewStyles.sidebar}>
        <View style={[styles.previewLine, styles.sidebarLineWide, previewStyles.mutedLine]} />
        <View style={[styles.previewLine, styles.sidebarLineNarrow, previewStyles.mutedLine]} />
        <View style={[styles.previewLine, styles.sidebarLineMedium, previewStyles.mutedLine]} />
      </View>
      <View style={styles.previewMain}>
        <View style={[styles.previewTitle, previewStyles.strongLine]} />
        <View style={[styles.previewLine, styles.mainLineWide, previewStyles.mutedLine]} />
        <View style={[styles.previewLine, styles.mainLineNarrow, previewStyles.mutedLine]} />
        <View style={previewStyles.bubble} />
      </View>
    </View>
  );
}

/** "System" follows the OS: light on the left half, the preferred dark variant on the right. */
function SystemThemePreview() {
  const { settings } = useAppSettings();
  const preferredDark = DARK_THEME_OPTIONS.find(
    (option) => option.name === settings.preferredDarkTheme,
  );
  return (
    <View style={styles.preview}>
      <ThemePreview theme={lightTheme} />
      <View style={styles.systemDarkHalf}>
        <View style={styles.systemDarkOffset}>
          <ThemePreview theme={preferredDark?.theme ?? darkTheme} />
        </View>
      </View>
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
  previewFrame: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[1],
  },
  preview: {
    width: "100%",
    aspectRatio: PREVIEW_ASPECT_RATIO,
    flexDirection: "row",
    overflow: "hidden",
  },
  previewSidebar: {
    width: 36,
    paddingHorizontal: 6,
    paddingVertical: 8,
    gap: 5,
  },
  previewMain: {
    flex: 1,
    padding: 8,
    gap: 5,
  },
  previewLine: {
    height: 4,
    borderRadius: 2,
    opacity: 0.6,
  },
  previewTitle: {
    width: "55%",
    height: 5,
    borderRadius: 2,
  },
  sidebarLineWide: { width: "100%" },
  sidebarLineNarrow: { width: "60%" },
  sidebarLineMedium: { width: "80%" },
  mainLineWide: { width: "90%" },
  mainLineNarrow: { width: "65%" },
  previewBubble: {
    marginTop: "auto",
    alignSelf: "flex-end",
    width: "45%",
    height: 10,
    borderRadius: 5,
  },
  systemDarkHalf: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: "50%",
    width: "50%",
    overflow: "hidden",
  },
  // A full-width dark preview shifted left by half, so only its right half shows.
  systemDarkOffset: {
    width: "200%",
    marginLeft: "-100%",
  },
}));
