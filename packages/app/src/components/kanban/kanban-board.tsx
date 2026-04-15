// KanbanBoard — main board component, adapted from emdash for React Native
// Renders 3 columns: To-do, In-progress, Ready for review
// On mobile: vertical stack. On desktop: horizontal grid.

import { useMemo } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Plus } from "lucide-react-native";
import type { KanbanTask, KanbanStatus } from "@/types/kanban";
import { KANBAN_COLUMNS, KANBAN_TITLES } from "@/types/kanban";
import { useKanbanStore, selectTasksByStatus } from "@/stores/kanban-store";
import { KanbanColumn } from "./kanban-column";
import { KanbanCard } from "./kanban-card";
import { KanbanEmpty } from "./kanban-empty";

interface KanbanBoardProps {
  serverId?: string;
  tasks?: KanbanTask[];
  statusByTask?: Record<string, KanbanStatus>;
  onStatusChange?: (taskId: string, status: KanbanStatus) => void;
  onOpenTask?: (task: KanbanTask) => void;
  onCreateTask?: () => void;
}

export function KanbanBoard({
  serverId,
  tasks: tasksProp,
  statusByTask: statusByTaskProp,
  onStatusChange,
  onOpenTask,
  onCreateTask,
}: KanbanBoardProps) {
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();

  const storeTasks = useKanbanStore((s) => s.tasks);
  const storeStatusByTask = useKanbanStore((s) => s.statusByTask);
  const tasks = tasksProp ?? storeTasks;
  const statusByTask = statusByTaskProp ?? storeStatusByTask;

  const byStatus = useMemo(() => selectTasksByStatus(tasks, statusByTask), [tasks, statusByTask]);

  const hasAny = tasks.length > 0;

  const renderColumn = (status: KanbanStatus) => {
    const columnTasks = byStatus[status];
    const isTodo = status === "todo";

    return (
      <KanbanColumn
        key={status}
        title={KANBAN_TITLES[status]}
        count={columnTasks.length}
        status={status}
        action={
          isTodo && onCreateTask ? (
            <Pressable
              style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}
              onPress={onCreateTask}
            >
              <Plus size={16} color={theme.colors.foreground} />
            </Pressable>
          ) : undefined
        }
      >
        {columnTasks.length === 0 ? (
          <KanbanEmpty showCreateButton={isTodo && !hasAny} onCreateTask={onCreateTask} />
        ) : (
          <>
            {columnTasks.map((task) => (
              <KanbanCard key={task.id} task={task} serverId={serverId} onPress={onOpenTask} />
            ))}
            {isTodo && onCreateTask ? (
              <Pressable
                style={({ pressed }) => [
                  styles.inlineCreateButton,
                  pressed && styles.inlineCreateButtonPressed,
                ]}
                onPress={onCreateTask}
              >
                <Plus size={14} color={theme.colors.foregroundMuted} />
                <Text style={styles.inlineCreateText}>New Task</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </KanbanColumn>
    );
  };

  if (isCompact) {
    // Mobile: vertical scrollable stack
    return (
      <ScrollView
        style={styles.mobileContainer}
        contentContainerStyle={styles.mobileContent}
        showsVerticalScrollIndicator={false}
      >
        {KANBAN_COLUMNS.map(renderColumn)}
      </ScrollView>
    );
  }

  // Desktop/tablet: horizontal grid
  return <View style={styles.desktopContainer}>{KANBAN_COLUMNS.map(renderColumn)}</View>;
}

const styles = StyleSheet.create((theme) => ({
  desktopContainer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[4],
    padding: theme.spacing[3],
  },
  mobileContainer: {
    flex: 1,
  },
  mobileContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[4],
  },
  addButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  addButtonPressed: {
    opacity: 0.7,
  },
  inlineCreateButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    marginTop: theme.spacing[1],
  },
  inlineCreateButtonPressed: {
    opacity: 0.7,
  },
  inlineCreateText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
}));
