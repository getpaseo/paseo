import { GOAL_CONFIG_BOUNDS } from "./config-bounds.js";
import {
  CAPTURE_FAILED_PREFIX,
  DEADLINE_REACHED_PATTERN,
  LEAD_STOP_PREFIX,
  RESUME_FAILED_PREFIX,
  RUN_CANCELED_TEXT,
  TIME_LIMIT_REACHED_PREFIX,
  TURN_TIMEOUT_PREFIX,
  WORK_NOT_RECOVERED_PREFIX,
  isCriteriaNotMetFailure,
  isNoAnswerFailure,
  isPendingRequestFailure,
  mentionsNoAnswer,
  isWorkerBlocked,
} from "./failure-wording.js";
import { MAX_RECOVERIES, capText } from "./interventions.js";
import { absoluteDeadlineMs, goalDeadlineMs, goalTimeoutMs, timeLimitEndMs } from "./time-limit.js";
import {
  CHANGE_SET_INTEGRATION_FAILED,
  CHANGE_SET_REWORK_FAILED,
  type ChangeSet,
  type Goal,
  type Task,
} from "./types.js";

/**
 * Why a goal failed and what would let it continue, computed from its state alone. The goal
 * payloads every client gets carry what it reads, so the app and the CLI compute the same
 * answer. It never reads `updatedAt`: any later event moves it.
 */

/** Why a failed goal stopped, in the order findings are reported. */
export type GoalFailureKind =
  | "review_rejected"
  | "planning"
  | "time"
  | "budget"
  | "run_limit"
  | "integration_failed"
  | "rework_failed"
  | "verification"
  | "stuck"
  | "capture"
  | "recovery_failed"
  | "unknown";

/** Whether a person must act before a recovery can work. */
export type PersonNeeded = "yes" | "no" | "depends";

export interface GoalFailureFinding {
  kind: GoalFailureKind;
  /** What would let the goal continue, for a person to read. */
  remedy: string;
  personNeeded: PersonNeeded;
}

/**
 * Why a failed or cancelled task's last run did not succeed. A failed task is read from its last
 * failed run; a cancelled task from its last run: that run's failure, "interrupted" when the
 * run was still going when the goal ended, or "cancelled" when the task never ran.
 */
export type TaskFailureCause =
  | "timeout"
  | "pending_request"
  /** Nobody answered the agent's request within limits.userWaitMinutes. */
  | "no_answer"
  /** The worker ended with `TASK_STATUS: blocked`: its own claim, quoted in lastError. */
  | "worker_blocked"
  | "lead_stopped"
  | "canceled"
  | "worker_error"
  | "interrupted"
  | "cancelled";

export interface TaskDiagnosis {
  taskId: string;
  status: Task["status"];
  cause: TaskFailureCause;
  /** The error of the last failed run, cut to MAX_DIAGNOSIS_ERROR_CHARS. */
  lastError: string | null;
  failedRuns: number;
  /** Failed runs since a person last retried the task; these count against maxAttempts. */
  countedFailures: number;
  interruptedRuns: number;
  /** Pending tasks that cannot run until this one succeeds. */
  blockedDependents: string[];
}

/** A limit that leaves no room to run, and the smallest setting that would. */
export interface BlockingLimit {
  limit: "goalTimeoutMinutes" | "deadlineAt" | "maxRuns" | "maxTotalTokens" | "maxCostUsd";
  /** The setting in force; null for deadlineAt when none is set. */
  current: number | string | null;
  /**
   * What was used, in the limit's unit (minutes the goal ran, runs, tokens, dollars). Absent
   * for goalTimeoutMinutes when the time the goal ran is not known, and for deadlineAt.
   */
  used?: number;
  /** The smallest value that leaves room; absent when no value within bounds does. */
  minimum?: number;
  note?: string;
}

export interface GoalDiagnosis {
  /** The first finding's kind. */
  kind: GoalFailureKind;
  findings: GoalFailureFinding[];
  /** When the goal failed, before any recovery that ended without applying. */
  failedAt: string | null;
  /**
   * The time limit had passed when the goal failed. Null when that is not known: the goal has
   * no `failedAt` (a daemon without goalRecovery) and its reason does not say.
   */
  timePassedAtFailure: boolean | null;
  /** The time limit or deadline has passed now, so a recovery or retry must choose a time mode. */
  timePassedNow: boolean;
  /** The failure reason the goal failed with, before any recovery that ended without applying. */
  failureReason: string | null;
  tasks: TaskDiagnosis[];
  blocked: string[];
  /**
   * Implement tasks that succeeded without changing anything. Information only: a task may
   * rightly find nothing to change, and nothing failed because of it.
   */
  unchanged: string[];
  /** Change sets not settled when the goal failed: neither merged, superseded nor rejected. */
  openChangeSets: { id: string; taskId: string; status: ChangeSet["status"] }[];
  merged: { changeSetId: string; taskId: string }[];
  runs: { used: number; max: number };
  blockingLimits: BlockingLimit[];
  /**
   * False when the goal cannot be recovered in place: a change set was rejected by review. One
   * whose merge or rework failed does not count; a recovery merges or reworks it again.
   */
  recoverable: boolean;
}

export const MAX_DIAGNOSIS_ERROR_CHARS = 1000;

const MINUTE = 60_000;
const LIMITS = GOAL_CONFIG_BOUNDS.limits;

/** What a person does about a request nobody answered within userWaitMinutes. */
const ANSWER_SOONER = "Answer sooner, or raise userWaitMinutes.";

function isIntegrationFailed(cs: ChangeSet): boolean {
  return cs.status === "rejected" && cs.rejectionReason === CHANGE_SET_INTEGRATION_FAILED;
}

function isReworkFailed(cs: ChangeSet): boolean {
  return cs.status === "rejected" && cs.rejectionReason === CHANGE_SET_REWORK_FAILED;
}

function causeOf(error: string): TaskFailureCause {
  if (error.startsWith(TURN_TIMEOUT_PREFIX)) return "timeout";
  if (isPendingRequestFailure(error)) return "pending_request";
  if (isNoAnswerFailure(error)) return "no_answer";
  if (isWorkerBlocked(error)) return "worker_blocked";
  if (error.startsWith(LEAD_STOP_PREFIX)) return "lead_stopped";
  if (error.startsWith(RUN_CANCELED_TEXT)) return "canceled";
  return "worker_error";
}

function taskCause(task: Task, runs: Goal["runs"], lastError: string | null): TaskFailureCause {
  if (task.status === "failed") return causeOf(lastError ?? task.error ?? "");
  const last = runs.at(-1);
  if (!last || last.status === "succeeded") return "cancelled";
  if (last.status === "failed") return causeOf(last.error ?? "");
  return "interrupted";
}

/** Pending tasks that can never run because a dependency failed or was cancelled. */
function blockedTasks(tasks: readonly Task[]): Task[] {
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

/** Blocked tasks that wait, directly or through other blocked tasks, on `taskId`. */
function dependentsOf(taskId: string, blocked: readonly Task[]): string[] {
  const reached = new Set([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of blocked) {
      if (!reached.has(task.id) && task.dependsOn.some((dep) => reached.has(dep))) {
        reached.add(task.id);
        changed = true;
      }
    }
  }
  return blocked.filter((t) => reached.has(t.id)).map((t) => t.id);
}

function diagnoseTask(goal: Goal, task: Task, blocked: readonly Task[]): TaskDiagnosis {
  const runs = goal.runs.filter((r) => r.taskId === task.id);
  const failed = runs.filter((r) => r.status === "failed");
  const lastError = failed.at(-1)?.error ?? null;
  return {
    taskId: task.id,
    status: task.status,
    cause: taskCause(task, runs, lastError),
    lastError: lastError === null ? null : capText(lastError, MAX_DIAGNOSIS_ERROR_CHARS),
    failedRuns: failed.length,
    countedFailures: failed.length - (task.forgivenFailures ?? 0),
    interruptedRuns: runs.filter((r) => r.status === "interrupted").length,
    blockedDependents: dependentsOf(task.id, blocked),
  };
}

interface Failure {
  reason: string | null;
  failedAt: string | null;
}

/**
 * The failure the goal failed with. A recovery that ended without applying rewrites the goal's
 * reason and failure time to its own; the ones it started from explain the goal, but only while
 * that ending is the goal's latest failure. A retry or an applied recovery that failed again
 * since has a reason of its own, and the recovery's copy is stale.
 */
function underlyingFailure(goal: Goal): Failure {
  const recovery = goal.recovery;
  if (!recovery) return { reason: goal.failureReason, failedAt: goal.failedAt ?? null };
  // A recovery still deciding started from the goal's failure as it was then, which an earlier
  // recovery's ending may have rewritten since.
  if (recovery.status !== "ended" && recovery.status !== "applied") {
    return { reason: recovery.failureReason, failedAt: recovery.failedAt ?? goal.failedAt ?? null };
  }
  if (
    recovery.status === "ended" &&
    recovery.outcome !== "applied" &&
    recovery.resolvedAt === goal.failedAt
  ) {
    return { reason: recovery.failureReason, failedAt: recovery.failedAt ?? null };
  }
  return { reason: goal.failureReason, failedAt: goal.failedAt ?? null };
}

function timeAtFailure(goal: Goal, failure: Failure): boolean | null {
  if (failure.failedAt)
    return Date.parse(failure.failedAt) >= goalDeadlineMs(goal, Date.parse(failure.failedAt));
  // COMPAT(goalFailedAt): goals from daemons without goalRecovery carry no failedAt; read the
  // reason the deadline timer wrote. Remove after 2027-10-28.
  const reason = failure.reason ?? "";
  if (reason.startsWith(TIME_LIMIT_REACHED_PREFIX) || DEADLINE_REACHED_PATTERN.test(reason)) {
    return true;
  }
  return null;
}

function budgetExceeded(goal: Goal): boolean {
  const usage = goal.usage;
  if (!usage) return false;
  const tokens = goal.config?.limits?.maxTotalTokens;
  const cost = goal.config?.limits?.maxCostUsd;
  return (
    (tokens !== undefined && usage.totalTokens >= tokens) ||
    (cost !== undefined && usage.costUsd >= cost)
  );
}

function maxRunsOf(goal: Goal): number {
  return goal.config?.limits?.maxRuns ?? LIMITS.maxRuns.default;
}

const GOAL_TIMEOUT_CAP_NOTE = `goalTimeoutMinutes is at most ${LIMITS.goalTimeoutMinutes.max} (7 days); use time mode fresh`;

/**
 * The time limit in force has passed now: which setting blocks, and what would unblock it. A
 * time mode the person already chose restarts the limit, so it no longer blocks, unless
 * remaining leaves nothing.
 */
function timeLimits(goal: Goal, options: DiagnoseOptions): BlockingLimit[] {
  const { now, activeMs, timeMode } = options;
  const limits: BlockingLimit[] = [];
  const absolute = absoluteDeadlineMs(goal);
  if (absolute !== null && now >= absolute) {
    limits.push({
      limit: "deadlineAt",
      current: goal.config?.limits?.deadlineAt ?? null,
      note: "the deadline has passed; set a later one or clear it before recovering",
    });
  }
  if (now < timeLimitEndMs(goal, now) || timeMode === "fresh") return limits;
  const nothingLeft = activeMs !== undefined && activeMs >= goalTimeoutMs(goal);
  if (timeMode === "remaining" && !nothingLeft) return limits;
  const blocking: BlockingLimit = {
    limit: "goalTimeoutMinutes",
    current: Math.round(goalTimeoutMs(goal) / MINUTE),
    ...(activeMs === undefined ? {} : { used: Math.round(activeMs / MINUTE) }),
  };
  if (activeMs !== undefined && nothingLeft) {
    // Time mode remaining leaves nothing; raise the limit past the time the goal ran.
    const minimum = Math.floor(activeMs / MINUTE) + 1;
    if (minimum <= LIMITS.goalTimeoutMinutes.max) blocking.minimum = minimum;
    else blocking.note = GOAL_TIMEOUT_CAP_NOTE;
  }
  limits.push(blocking);
  return limits;
}

function runLimit(goal: Goal): BlockingLimit | null {
  const max = maxRunsOf(goal);
  if (goal.runs.length < max) return null;
  const remaining = goal.tasks.filter((t) => t.status !== "succeeded").length;
  const attempts = goal.config?.maxAttempts ?? GOAL_CONFIG_BOUNDS.maxAttempts.default;
  const wanted = goal.runs.length + Math.max(1, remaining) * attempts;
  const limit: BlockingLimit = { limit: "maxRuns", current: max, used: goal.runs.length };
  if (wanted <= LIMITS.maxRuns.max) limit.minimum = wanted;
  else if (goal.runs.length < LIMITS.maxRuns.max) {
    limit.minimum = LIMITS.maxRuns.max;
    limit.note = `maxRuns is at most ${LIMITS.maxRuns.max}; that leaves fewer runs than the remaining tasks may need`;
  } else limit.note = `maxRuns is at most ${LIMITS.maxRuns.max}; no run is left`;
  return limit;
}

function budgetLimits(goal: Goal): BlockingLimit[] {
  const usage = goal.usage;
  if (!usage) return [];
  const limits: BlockingLimit[] = [];
  const tokens = goal.config?.limits?.maxTotalTokens;
  if (tokens !== undefined && usage.totalTokens >= tokens) {
    const minimum = Math.max(usage.totalTokens + 1, LIMITS.maxTotalTokens.min);
    limits.push({
      limit: "maxTotalTokens",
      current: tokens,
      used: usage.totalTokens,
      ...(minimum <= LIMITS.maxTotalTokens.max ? { minimum } : {}),
      note: "the minimum leaves room for almost nothing; raise it by what the remaining work needs",
    });
  }
  const cost = goal.config?.limits?.maxCostUsd;
  if (cost !== undefined && usage.costUsd >= cost) {
    const minimum = Math.round((usage.costUsd + 0.01) * 100) / 100;
    limits.push({
      limit: "maxCostUsd",
      current: cost,
      used: usage.costUsd,
      ...(minimum <= LIMITS.maxCostUsd.max ? { minimum } : {}),
      note: "the minimum leaves room for almost nothing; raise it by what the remaining work needs",
    });
  }
  return limits;
}

interface FindingContext {
  goal: Goal;
  reason: string | null;
  timePassedAtFailure: boolean | null;
  timeMode: string | undefined;
  tasks: TaskDiagnosis[];
  blocked: Task[];
}

/** Every finding that applies, in the order they are reported. */
function findingsOf(context: FindingContext): GoalFailureFinding[] {
  const { goal, reason, tasks, blocked } = context;
  const findings: GoalFailureFinding[] = [];
  // First: nothing else matters while the goal cannot complete in place.
  const reviewRejected = goal.changeSets.filter(
    (c) => c.status === "rejected" && !isIntegrationFailed(c) && !isReworkFailed(c),
  );
  if (reviewRejected.length > 0) {
    findings.push({
      kind: "review_rejected",
      remedy: reviewRejected.some((c) => mentionsNoAnswer(c.error))
        ? `A reviewer waited longer than userWaitMinutes for a person's answer, so its change set was rejected and this goal cannot complete. ${ANSWER_SOONER} Start a new goal from its integration branch.`
        : "A change set was rejected by review, so this goal cannot complete. Start a new goal from its integration branch.",
      personNeeded: "yes",
    });
  }
  if (goal.tasks.length === 0) {
    findings.push(
      mentionsNoAnswer(reason)
        ? {
            kind: "planning",
            remedy: `The planning Lead waited longer than userWaitMinutes for a person's answer. ${ANSWER_SOONER} Then retry.`,
            personNeeded: "yes",
          }
        : {
            kind: "planning",
            remedy:
              "The goal failed before it had a plan. Retry it with an instruction for the planning Lead, after changing the setting that stopped it.",
            personNeeded: "depends",
          },
    );
  }
  // Time next: once the limit passed, nothing else could have finished it.
  if (context.timePassedAtFailure === true) findings.push(timeFinding(context.timeMode));
  if (budgetExceeded(goal)) {
    findings.push({
      kind: "budget",
      remedy: "Raise maxTotalTokens or maxCostUsd, then recover.",
      personNeeded: "yes",
    });
  }
  if (goal.runs.length >= maxRunsOf(goal)) {
    findings.push({
      kind: "run_limit",
      remedy: "Raise maxRuns, then recover.",
      personNeeded: "yes",
    });
  }
  if (goal.changeSets.some(isIntegrationFailed)) {
    findings.push({
      kind: "integration_failed",
      remedy:
        "A merge failed. Recovering merges it again; clean any dirty tracked files the error names in the integration worktree first.",
      personNeeded: "depends",
    });
  }
  const reworks = goal.changeSets.filter(isReworkFailed);
  if (reworks.length > 0) findings.push(reworkFinding(goal, reworks, tasks));
  if (
    goal.tasks.length > 0 &&
    goal.tasks.every((t) => t.status === "succeeded") &&
    goal.criteria.some((c) => !c.verifiedAt) &&
    context.timePassedAtFailure !== true
  ) {
    findings.push(verificationFinding(goal, reason));
  }
  if (tasks.some((t) => t.status === "failed") || blocked.length > 0) {
    const workerBlocked = tasks.some((t) => t.cause === "worker_blocked");
    findings.push({
      kind: "stuck",
      remedy: workerBlocked
        ? "A worker reported it was blocked. Fix what it names, then retry; the claim is the worker's own."
        : "A task failed for good. See each task's cause; recover with advice for it or a revised plan.",
      personNeeded:
        workerBlocked || tasks.some((t) => t.cause === "pending_request" || t.cause === "no_answer")
          ? "yes"
          : "depends",
    });
  }
  const byReason = reasonFinding(reason);
  if (byReason) findings.push(byReason);
  return findings;
}

/**
 * Every task succeeded but a criterion is unverified. When the verifier judged it unmet, a
 * recovery's Lead can add fix tasks, after which every criterion is verified again. When it was
 * never judged (the verifier gave no usable answer, or time ran out mid-verification), a recovery
 * with retry asks the verifier again. With no recovery left only a person can go on.
 */
function verificationFinding(goal: Goal, reason: string | null): GoalFailureFinding {
  const notMet = isCriteriaNotMetFailure(reason);
  const what = notMet
    ? "Every task succeeded but a criterion was not met"
    : "Every task succeeded but verification did not finish, so a criterion was not verified";
  const left = MAX_RECOVERIES - (goal.recoveries ?? 0);
  if (left <= 0) {
    // A retry does not reopen a goal with nothing failed, so with no recovery left the next
    // step is a person's: accept the goal as is, or start a follow-up goal.
    return {
      kind: "verification",
      remedy: `${what}, and all ${MAX_RECOVERIES} recoveries are used. Accept the goal as is or start a follow-up goal from its integration branch.`,
      personNeeded: "yes",
    };
  }
  if (mentionsNoAnswer(reason)) {
    return {
      kind: "verification",
      remedy: `Every task succeeded but the verifier waited longer than userWaitMinutes for a person's answer. ${ANSWER_SOONER} Then recover with retry: the verifier is asked again.`,
      personNeeded: "yes",
    };
  }
  const next = notMet
    ? "Recover: the Lead can add fix tasks, and every criterion is checked again afterwards."
    : "Recover with retry: the verifier is asked again about the criteria not verified.";
  const last = left === 1 ? " This is the last recovery." : "";
  return { kind: "verification", remedy: `${what}. ${next}${last}`, personNeeded: "no" };
}

/**
 * A change set whose rework failed for good. A retry or recovery reopens it and runs the rework
 * again in the same worktree, so the remedy is whatever stopped the rework task.
 */
function reworkFinding(
  goal: Goal,
  reworks: readonly ChangeSet[],
  tasks: readonly TaskDiagnosis[],
): GoalFailureFinding {
  const ids = new Set(reworks.map((c) => c.id));
  const reworkTasks = new Set(
    goal.tasks.filter((t) => t.rework && ids.has(t.rework.changeSetId)).map((t) => t.id),
  );
  const causes = new Set(tasks.filter((t) => reworkTasks.has(t.taskId)).map((t) => t.cause));
  if (causes.has("pending_request")) {
    return {
      kind: "rework_failed",
      remedy:
        "A rework stopped on a request nobody could answer. Change the permission policy or resolve what asks, then retry or recover; the rework runs again in its worktree.",
      personNeeded: "yes",
    };
  }
  if (causes.has("no_answer")) {
    return {
      kind: "rework_failed",
      remedy:
        "A rework waited longer than userWaitMinutes for a person's answer. Answer sooner or raise userWaitMinutes, then retry or recover; the rework runs again in its worktree.",
      personNeeded: "yes",
    };
  }
  if (causes.has("worker_blocked")) {
    return {
      kind: "rework_failed",
      remedy:
        "The worker of a rework reported it could not do the task. Fix the cause it names, then retry or recover; the rework runs again in its worktree.",
      personNeeded: "yes",
    };
  }
  if (causes.has("timeout")) {
    return {
      kind: "rework_failed",
      remedy:
        "A rework timed out. Raise runTimeoutMinutes or recover with advice for it; the rework runs again in its worktree.",
      personNeeded: "depends",
    };
  }
  return {
    kind: "rework_failed",
    remedy:
      "A rework failed for good. Retry or recover runs it again in its worktree; see the rework task's cause.",
    personNeeded: "depends",
  };
}

function timeFinding(timeMode: string | undefined): GoalFailureFinding {
  if (timeMode) {
    return {
      kind: "time",
      remedy: `Resolved by the person's time mode ${timeMode}: the time limit restarts when the recovery applies.`,
      personNeeded: "no",
    };
  }
  return {
    kind: "time",
    remedy:
      "Recover or retry with time mode fresh (the full limit from when it applies) or remaining (the limit minus the time the goal ran). Change or clear a passed deadline first.",
    personNeeded: "yes",
  };
}

/** A failure the reason names: work that could not be captured, or a resume that failed. */
function reasonFinding(reason: string | null): GoalFailureFinding | null {
  if (reason?.startsWith(CAPTURE_FAILED_PREFIX) || reason?.startsWith(WORK_NOT_RECOVERED_PREFIX)) {
    return {
      kind: "capture",
      remedy:
        "The work of a task could not be captured. Recover to try again; if its worktree is gone, add the work again under a new task id.",
      personNeeded: "depends",
    };
  }
  if (reason?.startsWith(RESUME_FAILED_PREFIX)) {
    return {
      kind: "recovery_failed",
      remedy: "The daemon could not resume the goal after a restart. Recover to try again.",
      personNeeded: "depends",
    };
  }
  return null;
}

export interface DiagnoseOptions {
  /** Now, in epoch milliseconds. */
  now: number;
  /**
   * Milliseconds the goal ran (goalActiveMs over its events), when known. It tells whether time
   * mode remaining leaves any time.
   */
  activeMs?: number;
  /**
   * The time mode the person chose for a recovery or retry, which restarts the time limit when
   * it applies. With it, a passed time limit no longer blocks, unless remaining leaves nothing.
   */
  timeMode?: string;
}

/** Why `goal` failed and what a recovery needs. Meant for a failed goal; any goal is read the same way. */
export function diagnoseGoalFailure(goal: Goal, options: DiagnoseOptions): GoalDiagnosis {
  const failure = underlyingFailure(goal);
  const reason = failure.reason;
  const blocked = blockedTasks(goal.tasks);
  const tasks = goal.tasks
    .filter((t) => t.status === "failed" || t.status === "cancelled")
    .map((t) => diagnoseTask(goal, t, blocked));
  const timePassedAtFailure = timeAtFailure(goal, failure);
  const findings = findingsOf({
    goal,
    reason,
    timePassedAtFailure,
    timeMode: options.timeMode,
    tasks,
    blocked,
  });
  const runLimitBlock = runLimit(goal);
  const blockingLimits = [
    ...timeLimits(goal, options),
    ...(runLimitBlock ? [runLimitBlock] : []),
    ...budgetLimits(goal),
  ];
  return {
    kind: findings[0]?.kind ?? "unknown",
    findings,
    failedAt: failure.failedAt,
    timePassedAtFailure,
    timePassedNow: options.now >= goalDeadlineMs(goal, options.now),
    failureReason: reason,
    tasks,
    blocked: blocked.map((t) => t.id),
    unchanged: goal.tasks
      .filter(
        (t) =>
          t.kind === "implement" &&
          t.status === "succeeded" &&
          t.captured === true &&
          !t.rework &&
          !goal.changeSets.some((c) => c.taskId === t.id),
      )
      .map((t) => t.id),
    openChangeSets: goal.changeSets
      .filter((c) => !["integrated", "superseded", "rejected"].includes(c.status))
      .map((c) => ({ id: c.id, taskId: c.taskId, status: c.status })),
    merged: goal.changeSets
      .filter((c) => c.status === "integrated")
      .map((c) => ({ changeSetId: c.id, taskId: c.taskId })),
    runs: { used: goal.runs.length, max: maxRunsOf(goal) },
    blockingLimits,
    recoverable: !findings.some((f) => f.kind === "review_rejected"),
  };
}
