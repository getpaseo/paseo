// TaskItem — adapted from emdash's TaskItem.tsx for React Native
// Individual task row with name, branch, status, context badges, and actions

import { useCallback, useState } from "react";
import { View, Text, Pressable, Alert } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { GitBranch, MoreHorizontal, Trash2, Archive, Loader2 } from "lucide-react-native";
import type { KanbanTask, KanbanStatus } from "@/types/kanban";
import { TaskStatusIndicator } from "./task-status-indicator";
import { TaskChangesBadge } from "./task-changes-badge";
import { TaskContextBadges } from "./task-context-badges";
import type { TaskMetadata } from "@/types/integrations";

interface TaskItemProps {
  task: KanbanTask;
  status: KanbanStatus;
  isBusy?: boolean;
  isUnread?: boolean;
  changes?: { additions: number; deletions: number } | null;
  metadata?: TaskMetadata | null;
  onPress?: (task: KanbanTask) => void;
  onLongPress?: (task: KanbanTask) => void;
  onDelete?: (taskId: string) => void;
  onArchive?: (taskId: string) => void;
}

export function TaskItem({
  task,
  status,
  isBusy = false,
  isUnread = false,
  changes,
  metadata,
  onPress,
  onLongPress,
  onDelete,
  onArchive,
}: TaskItemProps) {
  const { theme } = useUnistyles();
  const [showActions, setShowActions] = useState(false);

  const derivedStatus = isBusy ? "working" : isUnread ? "unread" : "idle";

  const handlePress = useCallback(() => {
    onPress?.(task);
  }, [onPress, task]);

  const handleLongPress = useCallback(() => {
    if (onLongPress) {
      onLongPress(task);
    } else {
      // Show action menu on long press
      Alert.alert(task.name, undefined, [
        ...(onArchive ? [{ text: "Archive", onPress: () => onArchive(task.id) }] : []),
        ...(onDelete
          ? [
              {
                text: "Delete",
                style: "destructive" as const,
                onPress: () => onDelete(task.id),
              },
            ]
          : []),
        { text: "Cancel", style: "cancel" as const },
      ]);
    }
  }, [onLongPress, onArchive, onDelete, task]);

  return (
    <Pressable
      style={({ pressed, hovered }) => [
        itemStyles.container,
        hovered && itemStyles.containerHovered,
        pressed && itemStyles.containerPressed,
      ]}
      onPress={handlePress}
      onLongPress={handleLongPress}
    >
      <View style={itemStyles.content}>
        <View style={itemStyles.leftSection}>
          <TaskStatusIndicator status={derivedStatus} />
          <View style={itemStyles.textSection}>
            <Text style={itemStyles.name} numberOfLines={1}>
              {task.name}
            </Text>
            {task.branch ? (
              <View style={itemStyles.branchRow}>
                <GitBranch size={10} color={theme.colors.foregroundMuted} />
                <Text style={itemStyles.branch} numberOfLines={1}>
                  {task.branch}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={itemStyles.rightSection}>
          {changes ? (
            <TaskChangesBadge additions={changes.additions} deletions={changes.deletions} />
          ) : null}
          {metadata ? (
            <TaskContextBadges
              linearIssue={metadata.linearIssue}
              githubIssue={metadata.githubIssue}
              jiraIssue={metadata.jiraIssue}
              gitlabIssue={metadata.gitlabIssue}
              plainThread={metadata.plainThread}
              forgejoIssue={metadata.forgejoIssue}
            />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const itemStyles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface1,
  },
  containerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  containerPressed: {
    opacity: 0.8,
  },
  content: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  leftSection: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  textSection: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  branchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginTop: 2,
  },
  branch: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  rightSection: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
}));
