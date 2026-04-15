// TaskDeleteButton — adapted from emdash's TaskDeleteButton.tsx
// Confirmation dialog before deleting a task

import { useCallback, useState } from "react";
import { View, Text, Pressable, Alert } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Trash2 } from "lucide-react-native";
import { isWeb } from "@/constants/platform";

interface TaskDeleteButtonProps {
  taskId: string;
  taskName: string;
  onDelete: (taskId: string) => void;
  hasUncommittedChanges?: boolean;
}

export function TaskDeleteButton({
  taskId,
  taskName,
  onDelete,
  hasUncommittedChanges = false,
}: TaskDeleteButtonProps) {
  const { theme } = useUnistyles();

  const handlePress = useCallback(() => {
    const warningMessage = hasUncommittedChanges
      ? `This task has uncommitted changes. Are you sure you want to delete "${taskName}"?`
      : `Are you sure you want to delete "${taskName}"?`;

    Alert.alert("Delete Task", warningMessage, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => onDelete(taskId),
      },
    ]);
  }, [taskId, taskName, onDelete, hasUncommittedChanges]);

  return (
    <Pressable
      style={({ pressed }) => [deleteStyles.button, pressed && deleteStyles.buttonPressed]}
      onPress={handlePress}
      accessibilityLabel={`Delete task ${taskName}`}
    >
      <Trash2 size={14} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

const deleteStyles = StyleSheet.create((theme) => ({
  button: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPressed: {
    backgroundColor: theme.colors.surface2,
  },
}));
