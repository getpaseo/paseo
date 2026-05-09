import type { Task, TaskStore } from "./types.js";

export interface TaskGraph {
  allTasks: Task[];
  candidates: Task[];
  taskMap: Map<string, Task>;
  childrenMap: Map<string, Task[]>;
  candidateIds: Set<string>;
}

type TaskGraphStore = Pick<TaskStore, "list" | "get" | "getDescendants">;

export function sortByPriorityThenCreated(a: Task, b: Task): number {
  if (a.priority !== undefined && b.priority === undefined) return -1;
  if (a.priority === undefined && b.priority !== undefined) return 1;
  if (a.priority !== undefined && b.priority !== undefined) {
    if (a.priority !== b.priority) return a.priority - b.priority;
  }
  return a.created.localeCompare(b.created);
}

export function buildTaskMap(tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

export function buildChildrenMap(tasks: Task[]): Map<string, Task[]> {
  const childrenMap = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parentId) {
      const siblings = childrenMap.get(task.parentId) ?? [];
      siblings.push(task);
      childrenMap.set(task.parentId, siblings);
    }
  }
  return childrenMap;
}

export async function loadScopedTaskGraph(
  store: TaskGraphStore,
  scopeId?: string,
): Promise<TaskGraph> {
  const allTasks = await store.list();
  const candidates = await loadScopedCandidates(store, allTasks, scopeId);

  return {
    allTasks,
    candidates,
    taskMap: buildTaskMap(allTasks),
    childrenMap: buildChildrenMap(allTasks),
    candidateIds: new Set(candidates.map((task) => task.id)),
  };
}

async function loadScopedCandidates(
  store: TaskGraphStore,
  allTasks: Task[],
  scopeId?: string,
): Promise<Task[]> {
  if (!scopeId) {
    return allTasks;
  }

  const scopeTask = await store.get(scopeId);
  const descendants = await store.getDescendants(scopeId);
  return scopeTask ? [scopeTask, ...descendants] : descendants;
}
