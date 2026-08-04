import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Server } from "lucide-react-native";
import { HOST_COLORS, type HostBadgeModel, type HostColor } from "@/hosts/appearance";
import { identityColor } from "@/styles/identity-colors";
import type { Theme } from "@/styles/theme";

/**
 * The glyph size the badge draws at. Rows that place the badge alongside their own glyphs
 * match this so the line reads as one rank of peers.
 */
export const HOST_BADGE_ICON_SIZE = 12;

const ThemedServer = withUnistyles(Server);

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// Theme-independent, so the mapping per host color is fixed for the life of the module. A
// fresh `uniProps` identity on every render makes withUnistyles re-subscribe each pass.
const HOST_ICON_MAPPINGS: Record<HostColor, (theme: Theme) => { color: string }> = (() => {
  const byColor = {} as Record<HostColor, (theme: Theme) => { color: string }>;
  for (const color of HOST_COLORS) {
    byColor[color] = color === "none" ? mutedMapping : () => ({ color: identityColor(color) });
  }
  return byColor;
})();

/**
 * Which machine something lives on, drawn the same way everywhere it appears: a server glyph
 * in the host's identity color, and the host's name when the host is configured to show one.
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
        <Text style={styles.label} numberOfLines={1}>
          {badge.label}
        </Text>
      ) : null}
    </View>
  );
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
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    flexShrink: 1,
    minWidth: 0,
  },
}));
