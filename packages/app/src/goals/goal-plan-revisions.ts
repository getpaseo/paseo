import type { Goal, PlanRevision, PlanRevisionOp, Task } from "@getpaseo/protocol/goal/types";

/** A plan revision waiting for a person, or null. A person's own revision applies at once. */
export function pendingPlanRevision(goal: Pick<Goal, "planRevisions">): PlanRevision | null {
  return goal.planRevisions?.find((revision) => revision.status === "pending") ?? null;
}

/** Revisions that were decided, newest first. */
export function decidedPlanRevisions(goal: Pick<Goal, "planRevisions">): PlanRevision[] {
  return (goal.planRevisions ?? [])
    .filter((revision) => revision.status !== "pending")
    .toReversed();
}

/** The parts of a task spec a replace can change, besides its title. */
export type RevisionTaskField =
  | "description"
  | "kind"
  | "dependsOn"
  | "provider"
  | "thinking"
  | "runTimeoutMinutes";

export interface RevisionOpRow {
  kind: PlanRevisionOp["op"];
  taskId: string;
  /** The title after the change; for a removal, the title the task has now. */
  title: string;
  /** The title before a replace that renames the task; null otherwise. */
  previousTitle: string | null;
  /** What a replace changes besides the title, read against the current plan. */
  changed: RevisionTaskField[];
  /** Dependencies of an added or replaced task. */
  dependsOn: string[];
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

function changedFields(before: Task, after: Extract<PlanRevisionOp, { op: "replace" }>["task"]) {
  const changed: RevisionTaskField[] = [];
  if (before.description !== after.description) changed.push("description");
  if (before.kind !== after.kind) changed.push("kind");
  if (!sameIds(before.dependsOn, after.dependsOn)) changed.push("dependsOn");
  if ((before.provider ?? null) !== (after.provider ?? null)) changed.push("provider");
  if ((before.thinking ?? null) !== (after.thinking ?? null)) changed.push("thinking");
  if ((before.runTimeoutMinutes ?? null) !== (after.runTimeoutMinutes ?? null)) {
    changed.push("runTimeoutMinutes");
  }
  return changed;
}

/**
 * The ops of a revision as rows a person can read. `compare` reads each replace against the
 * current plan, which only makes sense while the revision is not applied yet: once applied, the
 * plan already holds the new spec.
 */
export function revisionOpRows(
  goal: Pick<Goal, "tasks">,
  ops: readonly PlanRevisionOp[],
  options: { compare: boolean },
): RevisionOpRow[] {
  return ops.map((op) => {
    if (op.op === "remove") {
      const task = goal.tasks.find((candidate) => candidate.id === op.taskId);
      return {
        kind: "remove",
        taskId: op.taskId,
        title: task?.title ?? op.taskId,
        previousTitle: null,
        changed: [],
        dependsOn: [],
      };
    }
    const before = options.compare
      ? goal.tasks.find((candidate) => candidate.id === op.task.id)
      : undefined;
    const renamed = op.op === "replace" && before && before.title !== op.task.title;
    return {
      kind: op.op,
      taskId: op.task.id,
      title: op.task.title,
      previousTitle: renamed ? before.title : null,
      changed: op.op === "replace" && before ? changedFields(before, op.task) : [],
      dependsOn: op.task.dependsOn,
    };
  });
}
