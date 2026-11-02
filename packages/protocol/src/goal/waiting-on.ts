import { interventionClass } from "./interventions.js";
import type { Goal, Task } from "./types.js";

export type GoalWaitingOnKind =
  | "paused"
  | "planning"
  | "plan_approval"
  | "change_set_approval"
  | "plan_revision_approval"
  | "lead_decision"
  | "running"
  | "review"
  | "merge"
  | "retry"
  | "verification"
  | "manual";

/** Translation keys, one per phrase. `params` fill the placeholders a translation may use. */
export type GoalWaitingOnKey =
  | "goals.waitingOn.paused"
  | "goals.waitingOn.planning"
  | "goals.waitingOn.manualPlan"
  | "goals.waitingOn.planApproval"
  | "goals.waitingOn.manualTasks"
  | "goals.waitingOn.changeSetApproval"
  | "goals.waitingOn.planRevisionApproval"
  | "goals.waitingOn.leadDecision"
  | "goals.waitingOn.runningTask"
  | "goals.waitingOn.startingTask"
  | "goals.waitingOn.review"
  | "goals.waitingOn.merge"
  | "goals.waitingOn.retry"
  | "goals.waitingOn.verification";

/**
 * Placeholders for a translation. Lists come joined with ", " so a translation can
 * use them as they are; `count` drives plural forms.
 */
export interface GoalWaitingOnParams {
  /** Items the phrase is about: tasks or change sets. */
  count?: number;
  /** Ids of those items, joined. */
  ids?: string;
  /** Title of the first task, for a phrase that names one. */
  title?: string;
  /** Tasks as `id (title)`, joined. */
  tasks?: string;
}

export interface GoalWaitingOn {
  kind: GoalWaitingOnKind;
  /** A short English phrase for display, such as "plan approval" or "running task t1 (Add tests)". */
  label: string;
  /** Translation key for the same phrase. */
  key: GoalWaitingOnKey;
  params: GoalWaitingOnParams;
}

/**
 * What a live goal is waiting on, derived from its state alone so every client
 * describes it the same way. Null for an ended goal.
 */
export function describeGoalWaitingOn(goal: Goal): GoalWaitingOn | null {
  if (goal.status === "completed" || goal.status === "failed" || goal.status === "cancelled") {
    return null;
  }
  if (goal.pausedAt) return fixed("paused", "resume (paused)", "goals.waitingOn.paused");
  if (goal.status === "planning") {
    return goal.config
      ? fixed("planning", "the Lead's plan", "goals.waitingOn.planning")
      : fixed("manual", "a plan to be proposed", "goals.waitingOn.manualPlan");
  }
  if (goal.status === "awaiting_plan_approval") {
    return fixed("plan_approval", "plan approval", "goals.waitingOn.planApproval");
  }
  if (!goal.config) {
    return fixed("manual", "task updates recorded by hand", "goals.waitingOn.manualTasks");
  }

  const held = goal.changeSets.filter((c) => c.status === "awaiting_human");
  if (held.length > 0) {
    return {
      kind: "change_set_approval",
      label: `change set approval: ${ids(held)}`,
      key: "goals.waitingOn.changeSetApproval",
      params: { count: held.length, ids: ids(held) },
    };
  }
  // A revision held for a person; one that needs no approval is decided at once.
  if (goal.planRevisions?.some((r) => r.status === "pending")) {
    return fixed(
      "plan_revision_approval",
      "approval of a plan change",
      "goals.waitingOn.planRevisionApproval",
    );
  }
  const deciding = leadDecision(goal);
  if (deciding) return deciding;
  const running = goal.tasks.filter((t) => t.status === "running");
  if (running.length > 0) {
    return {
      kind: "running",
      label: `running ${plural(running.length, "task")} ${tasks(running)}`,
      key: "goals.waitingOn.runningTask",
      params: taskParams(running),
    };
  }
  const reviewing = goal.changeSets.filter(
    (c) => c.status === "captured" || c.status === "in_review",
  );
  if (reviewing.length > 0) {
    return {
      kind: "review",
      label: `review of ${ids(reviewing)}`,
      key: "goals.waitingOn.review",
      params: { count: reviewing.length, ids: ids(reviewing) },
    };
  }
  const merging = goal.changeSets.filter(
    (c) => c.status === "approved" || c.status === "integrating",
  );
  if (merging.length > 0) {
    return {
      kind: "merge",
      label: `merge of ${ids(merging)}`,
      key: "goals.waitingOn.merge",
      params: { count: merging.length, ids: ids(merging) },
    };
  }
  const failed = goal.tasks.filter((t) => t.status === "failed");
  if (failed.length > 0) {
    return {
      kind: "retry",
      label: `retry of ${tasks(failed)}`,
      key: "goals.waitingOn.retry",
      params: taskParams(failed),
    };
  }
  if (goal.tasks.length > 0 && goal.tasks.every((t) => t.status === "succeeded")) {
    return fixed(
      "verification",
      "verification of the acceptance criteria",
      "goals.waitingOn.verification",
    );
  }
  const pending = goal.tasks.filter((t) => t.status === "pending");
  return {
    kind: "running",
    label: `starting ${plural(pending.length, "task")} ${tasks(pending)}`,
    key: "goals.waitingOn.startingTask",
    params: taskParams(pending),
  };
}

/**
 * The Lead was woken about a failed task. A check-in on a running task does not hold the
 * goal: the task keeps running meanwhile.
 */
function leadDecision(goal: Goal): GoalWaitingOn | null {
  const deciding = goal.interventions?.find(
    (i) => i.status === "open" && interventionClass(i) === "failure",
  );
  const taskId = deciding?.taskId;
  if (!taskId) return null;
  return {
    kind: "lead_decision",
    label: `the Lead's decision about ${taskId}`,
    key: "goals.waitingOn.leadDecision",
    params: { count: 1, ids: taskId, title: goal.tasks.find((t) => t.id === taskId)?.title ?? "" },
  };
}

function fixed(kind: GoalWaitingOnKind, label: string, key: GoalWaitingOnKey): GoalWaitingOn {
  return { kind, label, key, params: {} };
}

function taskParams(items: Task[]): GoalWaitingOnParams {
  return {
    count: items.length,
    ids: ids(items),
    title: items[0]?.title ?? "",
    tasks: tasks(items),
  };
}

function ids(items: { id: string }[]): string {
  return items.map((i) => i.id).join(", ");
}

function tasks(items: Task[]): string {
  return items.map((t) => `${t.id} (${t.title})`).join(", ");
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
