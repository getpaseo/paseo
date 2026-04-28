import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Plus, Check, Star, ExternalLink } from "lucide-react-native";
import { LibraryIcon } from "./library-icon";
import { TransportBadge } from "./transport-badge";
import type { McpTransport } from "@/api/library";
import { openExternalUrl } from "@/utils/open-external-url";

export interface McpCardProps {
  name: string;
  description: string;
  iconUrl: string | null;
  transport?: McpTransport;
  /** GitHub stars from the catalog source — rendered as a small badge. */
  stars?: number;
  /** Documentation URL — renders a small ↗ icon next to the trailing add button. */
  homepage?: string | null;
  /** True for entries already present in the user's library. */
  installed?: boolean;
  onPress: () => void;
}

function formatStars(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

/**
 * When the catalog homepage points at a GitHub repo, anchor to `#readme` so
 * the user lands on the install section. Other hosts (product sites) are
 * returned as-is.
 */
function readmeHref(href: string): string {
  try {
    const u = new URL(href);
    if (u.hostname === "github.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) return `https://github.com/${parts[0]}/${parts[1]}#readme`;
    }
  } catch {
    /* ignore */
  }
  return href;
}

/**
 * Single card in the MCP library grid. Mirrors the reference design:
 * icon + name + transport badge on top row, 1-line description below,
 * trailing + or ✓ icon depending on install state.
 */
export function McpCard({
  name,
  description,
  iconUrl,
  transport,
  stars,
  homepage,
  installed,
  onPress,
}: McpCardProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed, hovered }) => [
        styles.card,
        hovered && styles.hovered,
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${installed ? "Configure" : "Add"} ${name}`}
    >
      <LibraryIcon sourceUrl={iconUrl} name={name} size={40} />
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {transport ? <TransportBadge transport={transport} /> : null}
          {stars && stars > 0 ? (
            <View style={styles.stars}>
              <Star size={11} color="currentColor" />
              <Text style={styles.starsLabel}>{formatStars(stars)}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.description} numberOfLines={1}>
          {description}
        </Text>
      </View>
      {homepage ? (
        <Pressable
          onPress={(e) => {
            // Don't bubble — clicking the doc icon shouldn't open the Add modal.
            (e as unknown as { stopPropagation?: () => void }).stopPropagation?.();
            void openExternalUrl(readmeHref(homepage));
          }}
          style={({ hovered, pressed }) => [
            styles.docsIcon,
            hovered && styles.docsIconHovered,
            pressed && styles.docsIconPressed,
          ]}
          accessibilityRole="link"
          accessibilityLabel="Open documentation"
        >
          <ExternalLink size={14} color="currentColor" />
        </Pressable>
      ) : null}
      <View style={styles.trailingIcon}>
        {installed ? (
          <Check size={18} color="currentColor" />
        ) : (
          <Plus size={18} color="currentColor" />
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    minHeight: 72,
  },
  hovered: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.borderAccent,
  },
  pressed: {
    backgroundColor: theme.colors.surface3,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  name: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600" as const,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  description: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  trailingIcon: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
    color: theme.colors.foregroundMuted,
  },
  docsIcon: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
    color: theme.colors.foregroundMuted,
  },
  docsIconHovered: {
    backgroundColor: theme.colors.surface3,
    color: theme.colors.foreground,
  },
  docsIconPressed: {
    backgroundColor: theme.colors.surface3,
  },
  stars: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    color: theme.colors.foregroundMuted,
  },
  starsLabel: {
    fontSize: 11,
    fontVariant: ["tabular-nums"] as const,
    color: theme.colors.foregroundMuted,
  },
}));
