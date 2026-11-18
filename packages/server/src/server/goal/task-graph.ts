import type { Task, TaskSpec } from "@getpaseo/protocol/goal/types";

/** Ids the Manager gives rework tasks. */
export const RESERVED_ID = /-rw\d+$/;

export class TaskGraphError extends Error {}

/** Throws on reserved ids, duplicate ids, unknown or self dependencies, and cycles. */
export function validateTaskGraph(specs: readonly TaskSpec[]): void {
  assertNoReservedIds(specs);
  assertGraphShape(specs);
}

/** Throws when a spec uses an id reserved for rework tasks. */
export function assertNoReservedIds(specs: readonly TaskSpec[]): void {
  for (const spec of specs) {
    if (RESERVED_ID.test(spec.id)) {
      throw new TaskGraphError(`Task id ${spec.id} is reserved for rework tasks (ends in -rw<n>)`);
    }
  }
}

/**
 * Throws on duplicate ids, unknown or self dependencies, and cycles. Rework ids are
 * allowed, since a running goal's task list holds them.
 */
export function assertGraphShape(specs: readonly TaskSpec[]): void {
  const ids = new Set<string>();
  for (const spec of specs) {
    if (ids.has(spec.id)) {
      throw new TaskGraphError(`Duplicate task id: ${spec.id}`);
    }
    ids.add(spec.id);
  }
  for (const spec of specs) {
    for (const dep of spec.dependsOn) {
      if (dep === spec.id) {
        throw new TaskGraphError(`Task ${spec.id} depends on itself`);
      }
      if (!ids.has(dep)) {
        throw new TaskGraphError(`Task ${spec.id} depends on unknown task ${dep}`);
      }
    }
  }
  topologicalOrder(specs);
}

/** Kahn's algorithm. Ties keep input order so results are deterministic. */
export function topologicalOrder(specs: readonly TaskSpec[]): string[] {
  const remaining = new Map(specs.map((spec) => [spec.id, new Set(spec.dependsOn)]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const next = specs.find((spec) => remaining.get(spec.id)?.size === 0);
    if (!next) {
      throw new TaskGraphError("Task graph contains a cycle");
    }
    order.push(next.id);
    remaining.delete(next.id);
    for (const deps of remaining.values()) {
      deps.delete(next.id);
    }
  }
  return order;
}

/** Pending tasks whose dependencies have all succeeded, in input order. */
export function readyTasks(tasks: readonly Task[]): Task[] {
  const succeeded = new Set(tasks.filter((t) => t.status === "succeeded").map((t) => t.id));
  return tasks.filter(
    (task) => task.status === "pending" && task.dependsOn.every((dep) => succeeded.has(dep)),
  );
}

/** Pending tasks that can never run because a dependency failed or was cancelled. */
export function blockedTasks(tasks: readonly Task[]): Task[] {
  const dead = new Set(
    tasks.filter((t) => t.status === "failed" || t.status === "cancelled").map((t) => t.id),
  );
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (
        task.status === "pending" &&
        !blocked.has(task.id) &&
        task.dependsOn.some((dep) => dead.has(dep) || blocked.has(dep))
      ) {
        blocked.add(task.id);
        changed = true;
      }
    }
  }
  return tasks.filter((task) => blocked.has(task.id));
}
