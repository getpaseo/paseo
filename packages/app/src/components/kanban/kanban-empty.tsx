// Empty state for kanban columns

import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Inbox, Plus } from "lucide-react-native";

interface KanbanEmptyProps {
  showCreateButton?: boolean;
  onCreateTask?: () => void;
}

export function KanbanEmpty({ showCreateButton = false, onCreateTask }: KanbanEmptyProps) {
  const { theme } = useUnistyles();

  return (
    <View style={styles.container}>
      <View style={styles.iconContainer}>
        <Inbox size={14} color={theme.colors.foregroundMuted} />
      </View>
      <Text style={styles.text}>No items</Text>
      {showCreateButton && onCreateTask ? (
        <Pressable
          style={({ pressed }) => [styles.createButton, pressed && styles.createButtonPressed]}
          onPress={onCreateTask}
        >
          <Plus size={14} color={theme.colors.surface1} />
          <Text style={styles.createButtonText}>New Task</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
    alignItems: "center",
    gap: theme.spacing[3],
  },
  iconContainer: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  createButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    backgroundColor: theme.colors.foreground,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  createButtonPressed: {
    opacity: 0.8,
  },
  createButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.surface1,
  },
}));
