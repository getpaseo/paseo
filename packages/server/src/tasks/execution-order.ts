import type { Task, TaskStore } from "./types.js";
import {
  buildChildrenMap,
  getTasksById,
  isTaskExecutableInOrder,
  loadScopedTaskGraph,
  sortByPriorityThenCreated,
} from "./task-graph.js";

export interface ExecutionOrderResult {
  /** Tasks in execution order (done first, then pending) */
  timeline: Task[];
  /** Map from task ID to execution order index */
  orderMap: Map<string, number>;
  /** Task IDs that are blocked/unreachable */
  blocked: Set<string>;
}

/**
 * Computes execution order for tasks within a scope.
 * Simulates running `task ready` repeatedly until no tasks remain.
 *
 * @param store - Task store for fetching tasks
 * @param scopeId - Optional scope task ID (if omitted, uses all tasks)
 * @returns Execution order result with timeline, order map, and blocked tasks
 */
export async function computeExecutionOrder(
  store: TaskStore,
  scopeId?: string,
): Promise<ExecutionOrderResult> {
  const graph = await loadScopedTaskGraph(store, scopeId);

  const simDone = new Set(graph.doneTaskIds);
  const remaining = new Set(
    graph.candidates
      .filter((t) => t.status === "open" || t.status === "in_progress")
      .map((t) => t.id),
  );

  const timeline: Task[] = [];
  const orderMap = new Map<string, number>();
  let orderIdx = 0;

  const done = graph.candidates
    .filter((t) => t.status === "done")
    .sort((a, b) => a.created.localeCompare(b.created));
  for (const t of done) {
    timeline.push(t);
    orderMap.set(t.id, orderIdx++);
  }

  // Then pending tasks in execution order
  while (remaining.size > 0) {
    const readyNow = getTasksById(graph, remaining)
      .filter((task) => isTaskExecutableInOrder(graph, task.id, simDone))
      .sort(sortByPriorityThenCreated);

    if (readyNow.length === 0) break;

    const next = readyNow[0];
    timeline.push(next);
    orderMap.set(next.id, orderIdx++);
    simDone.add(next.id);
    remaining.delete(next.id);
  }

  // Remaining are blocked/unreachable
  const blocked = remaining;

  return { timeline, orderMap, blocked };
}

/**
 * Builds a map of parent ID to children sorted by execution order.
 */
export function buildSortedChildrenMap(
  tasks: Task[],
  orderMap: Map<string, number>,
): Map<string, Task[]> {
  const childrenMap = buildChildrenMap(tasks);

  for (const [parentId, children] of childrenMap) {
    children.sort((a, b) => {
      const orderA = orderMap.get(a.id) ?? Infinity;
      const orderB = orderMap.get(b.id) ?? Infinity;
      return orderA - orderB;
    });
    childrenMap.set(parentId, children);
  }

  return childrenMap;
}
