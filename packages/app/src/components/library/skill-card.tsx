import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Plus, Check, Puzzle, Star } from "lucide-react-native";
import { LibraryIcon } from "./library-icon";

export interface SkillCardProps {
  name: string;
  description: string;
  iconUrl: string | null;
  /** Stars (github-skills) or installs (skills.sh). Renders as a tiny badge. */
  popularity?: number;
  installed?: boolean;
  onPress: () => void;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

export function SkillCard({
  name,
  description,
  iconUrl,
  popularity,
  installed,
  onPress,
}: SkillCardProps) {
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
      {iconUrl ? (
        <LibraryIcon sourceUrl={iconUrl} name={name} size={40} />
      ) : (
        <View style={styles.iconFallback}>
          <Puzzle size={20} color="currentColor" />
        </View>
      )}
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {popularity && popularity > 0 ? (
            <View style={styles.stars}>
              <Star size={11} color="currentColor" />
              <Text style={styles.starsLabel}>{formatCount(popularity)}</Text>
            </View>
          ) : null}
        </View>
        {description ? (
          <Text style={styles.description} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </View>
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
  iconFallback: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.accent,
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
    lineHeight: 16,
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
  trailingIcon: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
    color: theme.colors.foregroundMuted,
  },
}));
