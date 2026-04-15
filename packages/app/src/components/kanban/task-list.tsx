// TaskList — adapted from emdash's TaskList.tsx for React Native
// Flat list of tasks with status grouping

import { useCallback, useMemo } from "react";
import { View, Text, Pressable, FlatList } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Plus } from "lucide-react-native";
import type { KanbanTask, KanbanStatus } from "@/types/kanban";
import { useKanbanStore, selectTasksByStatus } from "@/stores/kanban-store";
import { TaskItem } from "./task-item";

interface TaskListProps {
  onOpenTask?: (task: KanbanTask) => void;
  onCreateTask?: () => void;
  onDeleteTask?: (taskId: string) => void;
}

export function TaskList({ onOpenTask, onCreateTask, onDeleteTask }: TaskListProps) {
  const { theme } = useUnistyles();
  const tasks = useKanbanStore((s) => s.tasks);
  const statusByTask = useKanbanStore((s) => s.statusByTask);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const statusOrder: Record<KanbanStatus, number> = {
        "in-progress": 0,
        todo: 1,
        done: 2,
      };
      const aStatus = statusByTask[a.id] || "todo";
      const bStatus = statusByTask[b.id] || "todo";
      const orderDiff = statusOrder[aStatus] - statusOrder[bStatus];
      if (orderDiff !== 0) return orderDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [tasks, statusByTask]);

  const renderItem = useCallback(
    ({ item }: { item: KanbanTask }) => (
      <TaskItem
        task={item}
        status={statusByTask[item.id] || "todo"}
        onPress={onOpenTask}
        onDelete={onDeleteTask}
      />
    ),
    [statusByTask, onOpenTask, onDeleteTask],
  );

  const keyExtractor = useCallback((item: KanbanTask) => item.id, []);

  return (
    <View style={listStyles.container}>
      <FlatList
        data={sortedTasks}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={listStyles.listContent}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={listStyles.empty}>
            <Text style={listStyles.emptyText}>No tasks yet</Text>
          </View>
        }
        ListFooterComponent={
          onCreateTask ? (
            <Pressable
              style={({ pressed }) => [
                listStyles.createButton,
                pressed && listStyles.createButtonPressed,
              ]}
              onPress={onCreateTask}
            >
              <Plus size={14} color={theme.colors.foregroundMuted} />
              <Text style={listStyles.createButtonText}>New Task</Text>
            </Pressable>
          ) : null
        }
      />
    </View>
  );
}

const listStyles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  listContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  empty: {
    alignItems: "center",
    paddingVertical: theme.spacing[6],
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  createButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    marginTop: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.surface2,
  },
  createButtonPressed: {
    opacity: 0.7,
  },
  createButtonText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
}));
