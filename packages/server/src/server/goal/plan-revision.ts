import type {
  Goal,
  GoalConfig,
  LeadIntervention,
  PlanRevision,
  PlanRevisionOp,
  RecoveryDecision,
  Task,
  TaskSpec,
} from "@getpaseo/protocol/goal/types";
import { MAX_LEAD_HINT_CHARS } from "@getpaseo/protocol/goal/interventions";
import { budgetExceeded, resolveLimits } from "./goal-limits.js";
import { RESERVED_ID, TaskGraphError, assertGraphShape } from "./task-graph.js";

/** Messages are written for the Lead, which reads them and tries again. */
export class PlanRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanRevisionError";
  }
}

export type PlanRevisionSource = "lead" | "person";

/** Only tasks that never ran to an end can change: running and succeeded work is kept. */
const REVISABLE_STATUSES: ReadonlySet<Task["status"]> = new Set(["pending", "failed", "cancelled"]);

/** An intervention still waiting on the Lead's decision, or on approval of its revision. */
export function isInterventionLive(intervention: LeadIntervention): boolean {
  return intervention.status === "open" || intervention.status === "awaiting_approval";
}

function opTaskId(op: PlanRevisionOp): string {
  return op.op === "remove" ? op.taskId : op.task.id;
}

/** Ids of existing tasks the ops replace or remove. */
export function revisionTargets(ops: readonly PlanRevisionOp[]): Set<string> {
  return new Set(ops.filter((op) => op.op !== "add").map(opTaskId));
}

/** The revision waiting for its decision; at most one is pending at a time. */
export function pendingRevision(goal: Pick<Goal, "planRevisions">): PlanRevision | undefined {
  return goal.planRevisions?.find((r) => r.status === "pending");
}

/** A person's revision applies at once; the Lead's waits for a person unless plans auto-approve. */
export function revisionNeedsApproval(
  config: Pick<GoalConfig, "autoApprovePlan"> | null | undefined,
  source: string,
): boolean {
  return source !== "person" && !config?.autoApprovePlan;
}

/** Tasks removed by applied revisions. Their ids stay taken, since runs and events derive from them. */
export function removedTaskIds(goal: Pick<Goal, "planRevisions">): Set<string> {
  const removed = new Set<string>();
  for (const revision of goal.planRevisions ?? []) {
    if (revision.status !== "applied") continue;
    for (const op of revision.ops) {
      if (op.op === "remove") removed.add(op.taskId);
    }
  }
  return removed;
}

function failedRuns(goal: Goal, taskId: string): number {
  return goal.runs.filter((r) => r.taskId === taskId && r.status === "failed").length;
}

/**
 * Checks who may propose a revision now. Run at proposal only: an intervention that opens
 * while a Lead revision waits does not void that revision.
 */
export function checkRevisionSource(
  goal: Goal,
  source: string,
  interventionId: string | undefined,
): void {
  if (source !== "lead" && source !== "person") {
    throw new PlanRevisionError(`Unknown revision source "${source}"; expected lead or person.`);
  }
  if (interventionId && source !== "lead") {
    throw new PlanRevisionError("Only the Lead answers an intervention.");
  }
  if (source === "lead" && !interventionId) {
    const live = (goal.interventions ?? []).find(isInterventionLive);
    if (live) {
      const about = live.taskId === undefined ? "this goal" : `task ${live.taskId}`;
      throw new PlanRevisionError(
        `The Manager asked you to decide about ${about}; answer the decision prompt instead of revising the plan.`,
      );
    }
  }
}

function checkIntervention(
  goal: Goal,
  ops: readonly PlanRevisionOp[],
  interventionId: string,
): void {
  const intervention = (goal.interventions ?? []).find((i) => i.id === interventionId);
  if (!intervention) {
    throw new PlanRevisionError(`Unknown intervention ${interventionId}.`);
  }
  // An intervention about one task is answered by changing that task.
  if (intervention.taskId !== undefined && !revisionTargets(ops).has(intervention.taskId)) {
    throw new PlanRevisionError(
      `This revision answers the failure of task ${intervention.taskId}, so it must replace or remove ${intervention.taskId}.`,
    );
  }
}

function checkTarget(goal: Goal, tasks: readonly Task[], taskId: string): Task {
  const target = tasks.find((t) => t.id === taskId);
  if (!target) {
    throw new PlanRevisionError(`Task ${taskId} does not exist; use add for a new task.`);
  }
  if (!REVISABLE_STATUSES.has(target.status)) {
    throw new PlanRevisionError(
      `Task ${taskId} is ${target.status} and cannot change; give new work a new id.`,
    );
  }
  if (target.rework) {
    throw new PlanRevisionError(
      `Task ${taskId} is a rework task the Manager owns and cannot be revised.`,
    );
  }
  // A task cancelled mid-run keeps its run until the agent stops.
  if (goal.runs.some((r) => r.taskId === taskId && r.status === "running")) {
    throw new PlanRevisionError(`Task ${taskId} still has a live run; wait for it to end.`);
  }
  return target;
}

function checkNewId(goal: Goal, tasks: readonly Task[], spec: TaskSpec): void {
  if (RESERVED_ID.test(spec.id)) {
    throw new PlanRevisionError(
      `Task id ${spec.id} is reserved for rework tasks (ends in -rw<n>).`,
    );
  }
  if (tasks.some((t) => t.id === spec.id)) {
    throw new PlanRevisionError(
      `Task ${spec.id} already exists; use replace to change it, or give new work a new id.`,
    );
  }
  if (removedTaskIds(goal).has(spec.id) || goal.runs.some((r) => r.taskId === spec.id)) {
    throw new PlanRevisionError(
      `Task id ${spec.id} was used earlier in this goal; give new work a new id.`,
    );
  }
}

function checkOneOpPerTask(ops: readonly PlanRevisionOp[]): void {
  if (ops.length === 0) {
    throw new PlanRevisionError("The revision changes nothing; give at least one op.");
  }
  const seen = new Set<string>();
  for (const op of ops) {
    const id = opTaskId(op);
    if (seen.has(id)) {
      throw new PlanRevisionError(`Task ${id} appears in more than one op; give one op per task.`);
    }
    seen.add(id);
  }
}

function applyOps(goal: Goal, ops: readonly PlanRevisionOp[]): Task[] {
  const tasks = [...goal.tasks];
  for (const op of ops) {
    if (op.op === "add") {
      checkNewId(goal, tasks, op.task);
      tasks.push({ ...op.task, status: "pending", attempts: 0, error: null, summary: null });
      continue;
    }
    const target = checkTarget(goal, tasks, opTaskId(op));
    const index = tasks.indexOf(target);
    if (op.op === "remove") {
      tasks.splice(index, 1);
      continue;
    }
    if (sameSpec(op.task, target)) {
      throw new PlanRevisionError(
        `Task ${target.id} would not change; give a different spec or leave it out.`,
      );
    }
    // Attempts carry over so run ids (<task>-a<n>) stay unique; earlier failures stop
    // counting against maxAttempts, as after a person's retry.
    tasks[index] = {
      ...op.task,
      status: "pending",
      attempts: target.attempts,
      error: null,
      summary: null,
      forgivenFailures: failedRuns(goal, target.id),
    };
  }
  return tasks;
}

/** New or replaced tasks need runs; refuse them when the run limit or a budget is used up. */
function checkRoomToRun(goal: Goal, ops: readonly PlanRevisionOp[]): void {
  if (ops.every((op) => op.op === "remove")) return;
  const { maxRuns } = resolveLimits(goal.config);
  if (goal.runs.length >= maxRuns) {
    throw new PlanRevisionError(
      `The goal's run limit of ${maxRuns} is used up, so new or replaced tasks cannot run; raise limits.maxRuns first.`,
    );
  }
  const overBudget = budgetExceeded(goal);
  if (overBudget) {
    throw new PlanRevisionError(`${overBudget}, so new or replaced tasks cannot run.`);
  }
}

/**
 * Checks a revision's ops against the goal and returns the task list they would produce.
 * Throws PlanRevisionError with a message the Lead can act on. Run at proposal and again on
 * approval, against the state at that moment.
 */
export function revisedPlan(
  goal: Goal,
  ops: readonly PlanRevisionOp[],
  interventionId?: string,
): Task[] {
  checkOneOpPerTask(ops);
  if (interventionId) checkIntervention(goal, ops, interventionId);
  checkRoomToRun(goal, ops);
  const tasks = applyOps(goal, ops);
  if (tasks.length === 0) {
    throw new PlanRevisionError("The revised plan has no tasks; cancel the goal instead.");
  }
  try {
    assertGraphShape(tasks);
  } catch (error) {
    if (error instanceof TaskGraphError) throw new PlanRevisionError(error.message);
    throw error;
  }
  const { maxTasks } = resolveLimits(goal.config);
  const planned = tasks.filter((t) => !t.rework).length;
  if (planned > maxTasks) {
    throw new PlanRevisionError(
      `The revised plan has ${planned} tasks but at most ${maxTasks} are allowed. Combine related work into fewer tasks.`,
    );
  }
  return tasks;
}

/**
 * Longest description an added or replaced task may have. A first plan has no such cap; a
 * revision is the Lead's answer to text it was shown from workers, so it is kept bounded.
 */
export const MAX_REVISED_DESCRIPTION_CHARS = 20_000;

/** Added and replaced tasks keep their descriptions within MAX_REVISED_DESCRIPTION_CHARS. */
export function checkDescriptions(ops: readonly PlanRevisionOp[]): void {
  for (const op of ops) {
    if (op.op !== "remove" && op.task.description.length > MAX_REVISED_DESCRIPTION_CHARS) {
      throw new PlanRevisionError(
        `Task ${op.task.id} has a description of ${op.task.description.length} characters; the limit is ${MAX_REVISED_DESCRIPTION_CHARS}. Keep it to what the worker needs.`,
      );
    }
  }
}

/** Everything a new proposal must pass: who proposes it, and what it does to the plan. */
export function validatePlanRevision(
  goal: Goal,
  ops: readonly PlanRevisionOp[],
  source: string,
  interventionId?: string,
): Task[] {
  checkRevisionSource(goal, source, interventionId);
  checkDescriptions(ops);
  return revisedPlan(goal, ops, interventionId);
}

/** The decisions a recovery takes. */
export const RECOVERY_DECISIONS = ["retry", "revise", "needs_person"] as const;

/**
 * Checks a recovery decision against the failed goal and returns the task list a revise would
 * produce (the current one otherwise). Hints advise the workers of failed or cancelled tasks;
 * a revise changes the plan as a revision would. Run when the decision is recorded and again
 * when it applies.
 */
export function checkRecoveryDecision(
  goal: Goal,
  decision: RecoveryDecision,
  interventionId: string | undefined,
): Task[] {
  if (!(RECOVERY_DECISIONS as readonly string[]).includes(decision.decision)) {
    throw new PlanRevisionError(
      `Unknown decision "${decision.decision}"; expected ${RECOVERY_DECISIONS.join(", ")}.`,
    );
  }
  const revise = decision.decision === "revise";
  if (revise !== (decision.ops !== undefined)) {
    throw new PlanRevisionError(
      revise ? "A revise decision needs ops." : `A ${decision.decision} decision carries no ops.`,
    );
  }
  if (decision.hints) checkHints(goal, decision);
  if (!decision.ops) return goal.tasks;
  checkDescriptions(decision.ops);
  return revisedPlan(goal, decision.ops, interventionId);
}

function checkHints(goal: Goal, decision: RecoveryDecision): void {
  if (decision.decision === "needs_person") {
    throw new PlanRevisionError("A needs_person decision carries no hints.");
  }
  for (const [taskId, hint] of Object.entries(decision.hints ?? {})) {
    const task = goal.tasks.find((t) => t.id === taskId);
    if (task?.status !== "failed" && task?.status !== "cancelled") {
      throw new PlanRevisionError(
        `Hints are for failed or cancelled tasks; ${taskId} is ${task?.status ?? "not a task of this goal"}.`,
      );
    }
    if (hint.length > MAX_LEAD_HINT_CHARS) {
      throw new PlanRevisionError(
        `The hint for ${taskId} has ${hint.length} characters; the limit is ${MAX_LEAD_HINT_CHARS}.`,
      );
    }
  }
}

/** The spec fields of a task in a fixed order, for comparison. Dependency order does not matter. */
function specOf(task: TaskSpec): TaskSpec {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    kind: task.kind,
    dependsOn: [...task.dependsOn].sort(),
    ...(task.provider === undefined ? {} : { provider: task.provider }),
    ...(task.thinking === undefined ? {} : { thinking: task.thinking }),
    ...(task.runTimeoutMinutes === undefined ? {} : { runTimeoutMinutes: task.runTimeoutMinutes }),
  };
}

function sameSpec(a: TaskSpec, b: TaskSpec): boolean {
  return JSON.stringify(specOf(a)) === JSON.stringify(specOf(b));
}

type TaskDiff =
  | { kind: "kept" }
  | { kind: "op"; op: PlanRevisionOp }
  | { kind: "missing" }
  | { kind: "error"; message: string };

/** How the desired plan treats one task of the goal. */
function diffTask(task: Task, spec: TaskSpec | undefined, removing: boolean): TaskDiff {
  if (!REVISABLE_STATUSES.has(task.status) || task.rework) {
    if ((!spec || sameSpec(spec, task)) && !removing) return { kind: "kept" };
    let state = `is ${task.status}`;
    if (task.rework) state = "is a rework task";
    else if (task.status === "succeeded") state = "succeeded";
    return {
      kind: "error",
      message: `${task.id} ${state} and cannot change; give new work a new id`,
    };
  }
  if (spec && removing)
    return { kind: "error", message: `${task.id} is both listed and in remove` };
  if (spec)
    return sameSpec(spec, task)
      ? { kind: "kept" }
      : { kind: "op", op: { op: "replace", task: spec } };
  return removing ? { kind: "op", op: { op: "remove", taskId: task.id } } : { kind: "missing" };
}

/**
 * Turns a desired task list into ops. Running, succeeded and rework tasks may be left out,
 * and when listed must be unchanged. Every pending, failed or cancelled task must be
 * listed or named in `remove`, so nothing is dropped by omission.
 */
export function diffDesiredPlan(
  goal: Goal,
  tasks: readonly TaskSpec[],
  remove: readonly string[],
): PlanRevisionOp[] {
  const desired = new Map<string, TaskSpec>();
  for (const spec of tasks) {
    if (desired.has(spec.id)) {
      throw new PlanRevisionError(`Task ${spec.id} is listed twice.`);
    }
    desired.set(spec.id, spec);
  }
  const removing = new Set(remove);
  const errors: string[] = [];
  const missing: string[] = [];
  const ops: PlanRevisionOp[] = [];
  for (const task of goal.tasks) {
    const diff = diffTask(task, desired.get(task.id), removing.has(task.id));
    if (diff.kind === "op") ops.push(diff.op);
    else if (diff.kind === "error") errors.push(diff.message);
    else if (diff.kind === "missing") missing.push(task.id);
  }
  if (missing.length > 0) {
    errors.push(
      `missing ${missing.join(", ")}: list each pending, failed or cancelled task, or name it in remove`,
    );
  }
  const known = new Set(goal.tasks.map((t) => t.id));
  for (const id of removing) {
    if (!known.has(id)) errors.push(`remove names unknown task ${id}`);
  }
  if (errors.length > 0) {
    throw new PlanRevisionError(`${errors.join("; ")}.`);
  }
  for (const spec of tasks) {
    if (!known.has(spec.id)) ops.push({ op: "add", task: spec });
  }
  if (ops.length === 0) {
    throw new PlanRevisionError("The desired plan matches the current plan; nothing to revise.");
  }
  return ops;
}
