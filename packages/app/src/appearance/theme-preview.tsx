import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { darkTheme, lightTheme, type Theme } from "@/styles/theme";

export function ThemePreviewFrame({ children }: { children: ReactNode }) {
  return <View style={styles.previewFrame}>{children}</View>;
}

export function ThemePreview({ theme }: { theme: Theme }) {
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

export function SystemThemePreview() {
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
  previewFrame: {
    width: "100%",
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  preview: {
    width: "100%",
    aspectRatio: 16 / 9,
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
    minWidth: 0,
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
  systemDarkOffset: {
    width: "200%",
    marginLeft: "-100%",
  },
}));
