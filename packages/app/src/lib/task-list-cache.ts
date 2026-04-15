// taskListCache — adapted from emdash's taskListCache.ts
// Utility for upserting tasks in a list

import type { KanbanTask } from "@/types/kanban";

export function upsertTaskInList(list: KanbanTask[], task: KanbanTask): KanbanTask[] {
  const idx = list.findIndex((t) => t.id === task.id || t.path === task.path);
  if (idx >= 0) {
    const updated = [...list];
    updated[idx] = { ...updated[idx], ...task };
    return updated;
  }
  return [...list, task];
}
