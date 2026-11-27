import type { WorkspaceRowBadgeItem } from "@getpaseo/plugin/client";
import type {
  WorkspaceRowBadgeProps,
  WorkspaceRowBadgesProps,
  WorkspaceRowBadgeTone,
} from "@getpaseo/plugin/client/ui";
import { type ComponentType, createContext, useContext, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HOST_BADGE_ICON_SIZE } from "@/hosts/host-badge";
import type { Theme } from "@/styles/theme";
import { parsePluginIcon, PluginIconView } from "../icons";

/** The item's title, the accessible name of a badge that has neither a label nor its own. */
export const WorkspaceRowBadgeTitleContext = createContext<string | undefined>(undefined);

export interface WorkspaceRowBadgesSource {
  readonly items: readonly WorkspaceRowBadgeItem[];
  readonly Badges: ComponentType<WorkspaceRowBadgesProps>;
}

/**
 * Plugins' badge items and the component that draws them. The sidebar view slot provides it; the kit cannot import
 * the plugin registry, which loads the kit.
 */
export const WorkspaceRowBadgesContext = createContext<WorkspaceRowBadgesSource | null>(null);

const NO_ITEMS: readonly WorkspaceRowBadgeItem[] = [];

/** Plugin badge items, listed for a sidebar view that renders its own rows. */
export function useWorkspaceRowBadgeItems(): readonly WorkspaceRowBadgeItem[] {
  return useContext(WorkspaceRowBadgesContext)?.items ?? NO_ITEMS;
}

/** Plugin badges for a workspace, drawn by a sidebar view that renders its own rows. */
export function WorkspaceRowBadges(props: WorkspaceRowBadgesProps) {
  const source = useContext(WorkspaceRowBadgesContext);
  return source ? <source.Badges {...props} /> : null;
}

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
 * A plugin's badge on the line under a workspace title, drawn like the row's own peers: one glyph
 * at the line's size and a short word, in the color of the state it reports. The plugin owns the
 * slot, so the badge draws no separator.
 */
export function WorkspaceRowBadge({
  icon,
  label,
  tone = "muted",
  accessibilityLabel,
}: WorkspaceRowBadgeProps) {
  const itemTitle = useContext(WorkspaceRowBadgeTitleContext);
  // Parsed at render, not registration, so an invalid icon throws to the item's boundary.
  const parsedIcon = useMemo(
    () => (icon === undefined ? null : parsePluginIcon("Workspace row badge", icon)),
    [icon],
  );
  if (!parsedIcon && !label) return null;
  return (
    <View style={styles.item} accessibilityLabel={accessibilityLabel ?? (label || itemTitle)}>
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
