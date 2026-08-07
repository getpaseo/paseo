import type { StreamItem, TodoEntry } from "@/types/stream";

export interface AgentTodoTrackSnapshot {
  items: TodoEntry[];
  completedCount: number;
  totalCount: number;
}

/**
 * Latest agent todo list from the stream (read-only).
 * Stream updates replace the previous todo_list for a provider; the newest
 * todo_list item is the current agent task list.
 */
export function selectLatestAgentTodos(
  streamItems: readonly StreamItem[] | null | undefined,
): AgentTodoTrackSnapshot | null {
  if (!streamItems || streamItems.length === 0) {
    return null;
  }

  for (let index = streamItems.length - 1; index >= 0; index -= 1) {
    const item = streamItems[index];
    if (item?.kind !== "todo_list") {
      continue;
    }
    const items = item.items ?? [];
    if (items.length === 0) {
      return null;
    }
    const completedCount = items.reduce((count, entry) => (entry.completed ? count + 1 : count), 0);
    return {
      items,
      completedCount,
      totalCount: items.length,
    };
  }

  return null;
}
