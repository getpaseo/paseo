import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Server } from "lucide-react-native";
import { HOST_COLORS, type HostBadgeModel, type HostColor } from "@/hosts/appearance";
import { identityForeground } from "@/styles/identity-colors";
import type { Theme } from "@/styles/theme";

/**
 * The glyph size the badge draws at. Rows that place the badge alongside their own glyphs
 * match this so the line reads as one rank of peers.
 */
export const HOST_BADGE_ICON_SIZE = 12;

const ThemedServer = withUnistyles(Server);

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// One stable mapping per host color for the life of the module — a fresh `uniProps` identity
// on every render makes withUnistyles re-subscribe each pass. The scheme is read inside the
// mapping rather than baked in, so a theme change repaints the glyph without a React render.
//
// Glyph and label share one color, so a badge reads as one object rather than a colored icon
// with an unrelated grey word beside it.
const HOST_ICON_MAPPINGS: Record<HostColor, (theme: Theme) => { color: string }> = (() => {
  const byColor = {} as Record<HostColor, (theme: Theme) => { color: string }>;
  for (const color of HOST_COLORS) {
    byColor[color] =
      color === "none"
        ? mutedMapping
        : (theme: Theme) => ({ color: identityForeground(color, theme.colorScheme) });
  }
  return byColor;
})();

/**
 * Which machine something lives on, drawn the same way everywhere it appears: a server glyph
 * and, when the host is configured to show one, its name — both in the host's identity color.
 *
 * A hostname is the least interesting thing on any line that carries it and the only one whose
 * length nobody chose, so the badge yields space before its neighbours rather than alongside
 * them — see `flexShrink` below.
 */
export function HostBadge({ badge }: { badge: HostBadgeModel }) {
  return (
    <View
      style={styles.badge}
      testID={`host-badge-${badge.serverId}`}
      accessibilityLabel={badge.label}
    >
      <ThemedServer size={HOST_BADGE_ICON_SIZE} uniProps={HOST_ICON_MAPPINGS[badge.color]} />
      {badge.showLabel ? (
        <Text style={[styles.label, labelColorStyle(badge.color)]} numberOfLines={1}>
          {badge.label}
        </Text>
      ) : null}
    </View>
  );
}

// Text has no `color` prop, so the label cannot ride the icon's uniProps mapping — its color
// has to come from a registered style. One entry per host color, picked at render time; a
// module-level lookup table would read the style proxies before the persisted theme lands.
function labelColorStyle(color: HostColor) {
  switch (color) {
    case "none":
      return null;
    case "violet":
      return styles.labelViolet;
    case "sky":
      return styles.labelSky;
    case "emerald":
      return styles.labelEmerald;
    case "orange":
      return styles.labelOrange;
    case "pink":
      return styles.labelPink;
    case "indigo":
      return styles.labelIndigo;
    case "teal":
      return styles.labelTeal;
    case "red":
      return styles.labelRed;
    case "amber":
      return styles.labelAmber;
    case "blue":
      return styles.labelBlue;
  }
}

const styles = StyleSheet.create((theme) => ({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    minWidth: 0,
    // Outweighs a sibling's `flexShrink: 1` by enough that the badge is effectively fully
    // squeezed before that sibling gives up its first pixel. An equal factor would split the
    // loss in proportion to length, which hands the most space to the longest hostname —
    // exactly backwards. The icon has a fixed width, so the badge never disappears outright.
    flexShrink: 100,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 1,
    minWidth: 0,
  },
  labelViolet: { color: identityForeground("violet", theme.colorScheme) },
  labelSky: { color: identityForeground("sky", theme.colorScheme) },
  labelEmerald: { color: identityForeground("emerald", theme.colorScheme) },
  labelOrange: { color: identityForeground("orange", theme.colorScheme) },
  labelPink: { color: identityForeground("pink", theme.colorScheme) },
  labelIndigo: { color: identityForeground("indigo", theme.colorScheme) },
  labelTeal: { color: identityForeground("teal", theme.colorScheme) },
  labelRed: { color: identityForeground("red", theme.colorScheme) },
  labelAmber: { color: identityForeground("amber", theme.colorScheme) },
  labelBlue: { color: identityForeground("blue", theme.colorScheme) },
}));
