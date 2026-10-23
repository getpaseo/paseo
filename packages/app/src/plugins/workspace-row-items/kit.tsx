import type { WorkspaceRowBadgeProps, WorkspaceRowBadgeTone } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HOST_BADGE_ICON_SIZE } from "@/hosts/host-badge";
import type { Theme } from "@/styles/theme";
import { parsePluginIcon, PluginIconView } from "../icons";
import { useWorkspaceRowItemFrame } from "./frame";

const ThemedPluginIconView = withUnistyles(PluginIconView);

function toneColor(theme: Theme, tone: WorkspaceRowBadgeTone): string {
  if (tone === "success") return theme.colors.statusSuccess;
  if (tone === "warning") return theme.colors.statusWarning;
  if (tone === "danger") return theme.colors.statusDanger;
  if (tone === "info") return theme.colors.statusDotRunning;
  return theme.colors.foregroundMuted;
}

const TONE_MAPPINGS: Record<WorkspaceRowBadgeTone, (theme: Theme) => { color: string }> = {
  muted: (theme) => ({ color: toneColor(theme, "muted") }),
  success: (theme) => ({ color: toneColor(theme, "success") }),
  warning: (theme) => ({ color: toneColor(theme, "warning") }),
  danger: (theme) => ({ color: toneColor(theme, "danger") }),
  info: (theme) => ({ color: toneColor(theme, "info") }),
};

/**
 * A plugin's item on the line under a workspace title, drawn like the row's own peers: one glyph at
 * the line's size and a short word, in the color of the state it reports. It brings its own
 * separator because only the badge knows whether the plugin drew anything at all.
 */
export function WorkspaceRowBadge({
  icon,
  label,
  tone = "muted",
  accessibilityLabel,
}: WorkspaceRowBadgeProps) {
  const frame = useWorkspaceRowItemFrame("WorkspaceRowBadge");
  // Parsed at render, not registration, so an invalid icon throws to the item's boundary.
  const parsedIcon = useMemo(
    () => (icon === undefined ? null : parsePluginIcon("Workspace row badge", icon)),
    [icon],
  );
  if (!parsedIcon && !label) return null;
  return (
    <>
      {frame.separated ? <Text style={styles.separator}>·</Text> : null}
      <View
        style={styles.item}
        accessibilityLabel={accessibilityLabel ?? label ?? frame.title}
        testID={frame.testID}
      >
        {parsedIcon ? (
          <ThemedPluginIconView
            icon={parsedIcon}
            size={HOST_BADGE_ICON_SIZE}
            uniProps={TONE_MAPPINGS[tone]}
          />
        ) : null}
        {label ? (
          <Text style={[styles.text, textToneStyle(tone)]} numberOfLines={1}>
            {label}
          </Text>
        ) : null}
      </View>
    </>
  );
}

// Read inside render, never into a module-scope table — see docs/unistyles.md.
function textToneStyle(tone: WorkspaceRowBadgeTone) {
  if (tone === "success") return styles.success;
  if (tone === "warning") return styles.warning;
  if (tone === "danger") return styles.danger;
  if (tone === "info") return styles.info;
  return styles.muted;
}

const styles = StyleSheet.create((theme) => ({
  separator: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    minWidth: 0,
    flexShrink: 1,
  },
  text: {
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 1,
  },
  muted: { color: toneColor(theme, "muted") },
  success: { color: toneColor(theme, "success") },
  warning: { color: toneColor(theme, "warning") },
  danger: { color: toneColor(theme, "danger") },
  info: { color: toneColor(theme, "info") },
}));
