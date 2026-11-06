import { useCallback, useMemo } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { PluginThemeOption } from "@/plugins/themes";
import { darkTheme, lightTheme, type Theme } from "@/styles/theme";

const PREVIEW_ASPECT_RATIO = 16 / 9;

export function PluginThemeTile({
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
      swatch={option.swatch}
    />
  );
}

export function ThemeTile({
  label,
  selected,
  onPress,
  previewTheme,
  swatch,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** "system" follows the OS, so its preview shows both halves. */
  previewTheme: Theme | "system";
  swatch?: string;
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
        <View style={styles.labelRow}>
          {swatch ? (
            <View
              testID="theme-picker-swatch"
              style={[styles.swatch, { backgroundColor: swatch }]}
            />
          ) : null}
          <Text style={styles.label} numberOfLines={1}>
            {label}
          </Text>
        </View>
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

/** "System" follows the OS: light on the left half, dark on the right. */
function SystemThemePreview() {
  return (
    <View style={styles.preview}>
      <ThemePreview theme={lightTheme} />
      <View style={styles.systemDarkHalf}>
        <View style={styles.systemDarkOffset}>
          <ThemePreview theme={darkTheme} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  swatch: {
    width: 10,
    height: 10,
    flexShrink: 0,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
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
