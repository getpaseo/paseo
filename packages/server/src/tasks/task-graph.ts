import type { Task, TaskStore } from "./types.js";

export interface TaskGraph {
  allTasks: Task[];
  candidates: Task[];
  taskMap: Map<string, Task>;
  childrenMap: Map<string, Task[]>;
  candidateIds: Set<string>;
  doneTaskIds: Set<string>;
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

export function isReadyTask(graph: TaskGraph, task: Task): boolean {
  return (
    task.status === "open" &&
    areTaskDepsDone(graph, task, graph.doneTaskIds) &&
    areTaskChildrenDone(graph, task.id, graph.doneTaskIds)
  );
}

export function isBlockedTask(graph: TaskGraph, task: Task): boolean {
  return (
    task.status !== "draft" &&
    task.status !== "done" &&
    task.deps.length > 0 &&
    !areTaskDepsDone(graph, task, graph.doneTaskIds)
  );
}

export function isTaskExecutableInOrder(
  graph: TaskGraph,
  taskId: string,
  completedTaskIds: Set<string>,
): boolean {
  const task = graph.taskMap.get(taskId);
  return (
    task !== undefined &&
    areTaskDepsDone(graph, task, completedTaskIds) &&
    areTaskChildrenDone(graph, task.id, completedTaskIds, { scoped: true })
  );
}

export function getTasksById(graph: TaskGraph, taskIds: Iterable<string>): Task[] {
  const tasks: Task[] = [];
  for (const taskId of taskIds) {
    const task = graph.taskMap.get(taskId);
    if (task) {
      tasks.push(task);
    }
  }
  return tasks;
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
    doneTaskIds: new Set(allTasks.filter((task) => task.status === "done").map((task) => task.id)),
  };
}

function areTaskDepsDone(graph: TaskGraph, task: Task, completedTaskIds: Set<string>): boolean {
  return task.deps.every((depId) => {
    const dep = graph.taskMap.get(depId);
    return dep !== undefined && completedTaskIds.has(depId);
  });
}

function areTaskChildrenDone(
  graph: TaskGraph,
  taskId: string,
  completedTaskIds: Set<string>,
  options?: { scoped: boolean },
): boolean {
  const children = graph.childrenMap.get(taskId) ?? [];
  return children.every((child) => {
    if (options?.scoped === true && !graph.candidateIds.has(child.id)) {
      return true;
    }
    return completedTaskIds.has(child.id);
  });
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
