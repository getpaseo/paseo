import type { Task, TaskStore } from "./types.js";

function sortByPriorityThenCreated(a: Task, b: Task): number {
  if (a.priority !== undefined && b.priority === undefined) return -1;
  if (a.priority === undefined && b.priority !== undefined) return 1;
  if (a.priority !== undefined && b.priority !== undefined) {
    if (a.priority !== b.priority) return a.priority - b.priority;
  }
  return a.created.localeCompare(b.created);
}

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
  scopeId?: string
): Promise<ExecutionOrderResult> {
  const allTasks = await store.list();
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  // Get scoped tasks
  let candidates: Task[];
  if (scopeId) {
    const scopeTask = await store.get(scopeId);
    const descendants = await store.getDescendants(scopeId);
    candidates = scopeTask ? [scopeTask, ...descendants] : descendants;
  } else {
    candidates = allTasks;
  }

  // Build children map
  const childrenMap = new Map<string, Task[]>();
  for (const t of allTasks) {
    if (t.parentId) {
      const siblings = childrenMap.get(t.parentId) ?? [];
      siblings.push(t);
      childrenMap.set(t.parentId, siblings);
    }
  }

  const candidateIds = new Set(candidates.map((t) => t.id));

  // Simulate execution: track done status
  // Include all done tasks (not just in scope) for dep resolution
  const simDone = new Set(
    allTasks.filter((t) => t.status === "done").map((t) => t.id)
  );
  const remaining = new Set(
    candidates
      .filter((t) => t.status === "open" || t.status === "in_progress")
      .map((t) => t.id)
  );

  const isReady = (taskId: string): boolean => {
    const task = taskMap.get(taskId);
    if (!task) return false;
    // All deps done (deps can be outside scope)
    const depsOk = task.deps.every((depId) => simDone.has(depId));
    // All children done (only consider children in scope)
    const children = (childrenMap.get(taskId) ?? []).filter((c) =>
      candidateIds.has(c.id)
    );
    const childrenOk = children.every((c) => simDone.has(c.id));
    return depsOk && childrenOk;
  };

  const timeline: Task[] = [];
  const orderMap = new Map<string, number>();
  let orderIdx = 0;

  // Done tasks first (by created date = historical execution order)
  const done = candidates
    .filter((t) => t.status === "done")
    .sort((a, b) => a.created.localeCompare(b.created));
  for (const t of done) {
    timeline.push(t);
    orderMap.set(t.id, orderIdx++);
  }

  // Then pending tasks in execution order
  while (remaining.size > 0) {
    const readyNow = [...remaining]
      .filter(isReady)
      .map((tid) => taskMap.get(tid)!)
      .sort(sortByPriorityThenCreated);

    if (readyNow.length === 0) break; // No more can be done (cycle or blocked)

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
  orderMap: Map<string, number>
): Map<string, Task[]> {
  const childrenMap = new Map<string, Task[]>();

  for (const t of tasks) {
    if (t.parentId) {
      const siblings = childrenMap.get(t.parentId) ?? [];
      siblings.push(t);
      childrenMap.set(t.parentId, siblings);
    }
  }

  // Sort each group by execution order
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
