import { memo, useMemo } from "react";
import { type GestureResponderEvent, Pressable, Text, View } from "react-native";
import { SmilePlus } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { ChatReactionGroup } from "@/api/chat";

interface ReactionsRowProps {
  reactions: readonly ChatReactionGroup[];
  currentUserId: string | null;
  onToggleReaction: (emoji: string, nextOp: "add" | "remove") => void;
  onOpenPicker?: (e: GestureResponderEvent) => void;
}

export const ReactionsRow = memo(function ReactionsRow({
  reactions,
  currentUserId,
  onToggleReaction,
  onOpenPicker,
}: ReactionsRowProps) {
  const { theme } = useUnistyles();
  const sorted = useMemo(() => [...reactions].sort((a, b) => b.count - a.count), [reactions]);

  if (sorted.length === 0) return null;

  return (
    <View style={styles.row}>
      {sorted.map((g) => {
        const mine = !!currentUserId && g.userIds.includes(currentUserId);
        return (
          <Pressable
            key={g.emoji}
            onPress={() => onToggleReaction(g.emoji, mine ? "remove" : "add")}
            style={[styles.chip, mine && styles.chipMine]}
            accessibilityRole="button"
          >
            <Text style={styles.chipEmoji}>{g.emoji}</Text>
            <Text style={[styles.chipCount, mine && styles.chipCountMine]}>{g.count}</Text>
          </Pressable>
        );
      })}
      {onOpenPicker ? (
        <Pressable
          onPress={onOpenPicker}
          style={styles.addChip}
          accessibilityRole="button"
          accessibilityLabel="Add reaction"
        >
          <SmilePlus size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipMine: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.brandMagenta,
  },
  chipEmoji: {
    fontSize: 13,
  },
  chipCount: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontWeight: "500",
  },
  chipCountMine: {
    color: theme.colors.brandMagenta,
    fontWeight: "600",
  },
  addChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
}));
