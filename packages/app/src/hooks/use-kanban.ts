// Kanban hooks — task management helpers
// Adapted from emdash's useTaskManagement, useTaskBusy, useTaskStatus

import { useCallback, useMemo } from "react";
import { useKanbanStore, selectTasksByStatus } from "@/stores/kanban-store";
import type { KanbanTask, KanbanStatus } from "@/types/kanban";
import { generateFriendlyTaskName } from "@/lib/task-names";

/**
 * Main hook for kanban task management operations.
 * Provides CRUD operations and status transitions.
 */
export function useKanbanManagement() {
  const tasks = useKanbanStore((s) => s.tasks);
  const statusByTask = useKanbanStore((s) => s.statusByTask);
  const addTask = useKanbanStore((s) => s.addTask);
  const removeTask = useKanbanStore((s) => s.removeTask);
  const updateTask = useKanbanStore((s) => s.updateTask);
  const setStatus = useKanbanStore((s) => s.setStatus);

  const tasksByStatus = useMemo(
    () => selectTasksByStatus(tasks, statusByTask),
    [tasks, statusByTask],
  );

  const existingNames = useMemo(() => tasks.map((t) => t.name), [tasks]);

  const createTask = useCallback(
    (overrides?: Partial<KanbanTask>) => {
      const name = overrides?.name || generateFriendlyTaskName(existingNames);
      const task: KanbanTask = {
        id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        createdAt: new Date().toISOString(),
        ...overrides,
      };
      addTask(task);
      return task;
    },
    [addTask, existingNames],
  );

  const deleteTask = useCallback(
    (taskId: string) => {
      removeTask(taskId);
    },
    [removeTask],
  );

  const moveTask = useCallback(
    (taskId: string, status: KanbanStatus) => {
      setStatus(taskId, status);
    },
    [setStatus],
  );

  const getTaskStatus = useCallback(
    (taskId: string): KanbanStatus => {
      return statusByTask[taskId] || "todo";
    },
    [statusByTask],
  );

  return {
    tasks,
    tasksByStatus,
    createTask,
    deleteTask,
    moveTask,
    updateTask,
    getTaskStatus,
  };
}

/**
 * Hook to get the count of tasks by status for badges/indicators.
 */
export function useKanbanCounts() {
  const tasks = useKanbanStore((s) => s.tasks);
  const statusByTask = useKanbanStore((s) => s.statusByTask);

  return useMemo(() => {
    const counts = { todo: 0, "in-progress": 0, done: 0 };
    for (const task of tasks) {
      const status = statusByTask[task.id] || "todo";
      counts[status]++;
    }
    return { ...counts, total: tasks.length };
  }, [tasks, statusByTask]);
}
