import { GOAL_DAEMON_BOUNDS } from "@getpaseo/protocol/goal/config-bounds";
import { goalActiveMs } from "@getpaseo/protocol/goal/active-time";
import {
  absoluteDeadlineMs,
  goalDeadlineMs,
  goalTimeoutMs,
  timeLimitEndMs,
} from "@getpaseo/protocol/goal/time-limit";
import { summarizeGoalProgress } from "@getpaseo/protocol/goal/progress";
import type {
  AgentRun,
  ChangeSet,
  ChangeSetStatus,
  Goal,
  GoalEvent,
  GoalProgressSummary,
  GoalSummary,
  Task,
} from "@getpaseo/protocol/goal/types";

type ProgressGoal = Pick<
  Goal,
  | "status"
  | "tasks"
  | "runs"
  | "changeSets"
  | "criteria"
  | "createdAt"
  | "timeBaseAt"
  | "waits"
  | "updatedAt"
  | "config"
  | "pausedAt"
  | "usage"
  | "verifyStartedAt"
  | "verifiedAt"
>;

const ENDED: ReadonlySet<Goal["status"]> = new Set(["completed", "failed", "cancelled"]);

// How much of the bar each stage is worth. Tasks dominate; planning and verification bracket them.
const PLAN_WEIGHT = 0.05;
const TASKS_WEIGHT = 0.85;
const VERIFY_WEIGHT = 0.1;
// An implement task is half done when its run succeeds, then reviewed, then merged.
const IMPLEMENT_RUN_SHARE = 0.5;
const IMPLEMENT_REVIEW_SHARE = 0.25;

const REVIEWED: ReadonlySet<ChangeSetStatus> = new Set(["approved", "integrating", "integrated"]);

function parseTime(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** How far one task has come, 0 to 1, counting review and merge for implement tasks. */
export function taskCompletion(goal: Pick<Goal, "changeSets">, task: Task): number {
  if (task.status !== "succeeded") {
    return 0;
  }
  if (task.kind !== "implement" || task.rework) {
    return 1;
  }
  const changeSets = goal.changeSets.filter(
    (changeSet) => changeSet.taskId === task.id && changeSet.status !== "superseded",
  );
  // Succeeded without a change set: either nothing changed, or capture has not run yet.
  if (changeSets.length === 0) {
    return task.captured ? 1 : IMPLEMENT_RUN_SHARE;
  }
  if (changeSets.every((changeSet) => changeSet.status === "integrated")) {
    return 1;
  }
  if (changeSets.every((changeSet) => REVIEWED.has(changeSet.status))) {
    return IMPLEMENT_RUN_SHARE + IMPLEMENT_REVIEW_SHARE;
  }
  return IMPLEMENT_RUN_SHARE;
}

/** Overall progress, 0 to 100, weighted over planning, tasks with their review and merge, and verification. */
export function goalPercent(goal: ProgressGoal): number {
  if (goal.status === "completed") {
    return 100;
  }
  const planned = goal.tasks.length > 0 && goal.status !== "awaiting_plan_approval";
  const planDone = planned && goal.status !== "planning" ? PLAN_WEIGHT : 0;
  const counted = goal.tasks.filter((task) => task.status !== "cancelled");
  const taskShare =
    counted.length === 0
      ? 0
      : counted.reduce((sum, task) => sum + taskCompletion(goal, task), 0) / counted.length;
  const verified = goal.criteria.filter((criterion) => criterion.verifiedAt !== null).length;
  const verifyShare = goal.criteria.length === 0 ? 0 : verified / goal.criteria.length;
  const raw = planDone + taskShare * TASKS_WEIGHT + verifyShare * VERIFY_WEIGHT;
  // Only completion reaches 100.
  return Math.min(99, Math.floor(raw * 100));
}

export interface GoalTaskCounts {
  done: number;
  running: number;
  remaining: number;
  failed: number;
  total: number;
}

export function countGoalTasks(goal: Pick<Goal, "tasks">): GoalTaskCounts {
  const counts: GoalTaskCounts = { done: 0, running: 0, remaining: 0, failed: 0, total: 0 };
  for (const task of goal.tasks) {
    if (task.status === "cancelled") {
      continue;
    }
    counts.total += 1;
    if (task.status === "succeeded") counts.done += 1;
    else if (task.status === "running") counts.running += 1;
    else if (task.status === "failed") counts.failed += 1;
    else counts.remaining += 1;
  }
  return counts;
}

/** Task counts for a list row: the host's summary, or the same counts for a host without it. */
export function goalListProgress(goal: GoalSummary): GoalProgressSummary {
  return goal.progress ?? summarizeGoalProgress(goal);
}

/** Time since the goal was created; frozen at its last update once it has ended. Never negative. */
export function goalElapsedMs(goal: ProgressGoal, now: number): number {
  const start = parseTime(goal.createdAt);
  if (start === null) {
    return 0;
  }
  const end = ENDED.has(goal.status) ? (parseTime(goal.updatedAt) ?? now) : now;
  return Math.max(0, end - start);
}

function runsOf(goal: Pick<Goal, "runs">, taskId: string): AgentRun[] {
  return goal.runs.filter((run) => run.taskId === taskId);
}

/** From the first run's start to the last run's end, or to now while it runs. Null before any run. */
export function taskDurationMs(goal: Pick<Goal, "runs">, task: Task, now: number): number | null {
  const runs = runsOf(goal, task.id);
  const starts = runs.map((run) => parseTime(run.startedAt)).filter((t): t is number => t !== null);
  if (starts.length === 0) {
    return null;
  }
  const start = Math.min(...starts);
  const isOpen = task.status === "running" || runs.some((run) => run.status === "running");
  const ends = runs.map((run) => parseTime(run.endedAt)).filter((t): t is number => t !== null);
  const end = isOpen || ends.length === 0 ? now : Math.max(...ends);
  return Math.max(0, end - start);
}

/** Fewer finished tasks than this and any estimate would be a guess. */
export const MIN_SAMPLES_FOR_ESTIMATE = 2;
// The daemon's default cap on workers across all goals (docs/goals.md "Concurrency"). The
// estimate does not read the host's configured cap: other goals share it anyway.
const DAEMON_WORKER_LIMIT = GOAL_DAEMON_BOUNDS.maxConcurrentRuns.default;

export type GoalEstimate =
  | { kind: "none" }
  | { kind: "paused" }
  | { kind: "estimating"; samples: number }
  | { kind: "range"; lowMs: number; highMs: number };

/** How long one stage took, or ran so far when it has not ended. Null before it starts. */
function stageMs(start: string | undefined, end: string | undefined, now: number): number | null {
  const from = parseTime(start);
  if (from === null) {
    return null;
  }
  const to = parseTime(end) ?? now;
  return Math.max(0, to - from);
}

export interface StageSamples {
  /** Finished reviews, from `reviewStartedAt` to `reviewedAt`. */
  review: number[];
  /** Finished merges, from `mergeStartedAt` to `mergedAt`. */
  merge: number[];
}

/** Durations of the reviews and merges that finished. Empty for daemons that predate stage times. */
export function stageSamples(goal: Pick<Goal, "changeSets">): StageSamples {
  const review: number[] = [];
  const merge: number[] = [];
  for (const changeSet of goal.changeSets) {
    if (changeSet.reviewStartedAt && changeSet.reviewedAt) {
      const ms = stageMs(changeSet.reviewStartedAt, changeSet.reviewedAt, 0);
      if (ms !== null && ms > 0) review.push(ms);
    }
    if (changeSet.mergeStartedAt && changeSet.mergedAt) {
      const ms = stageMs(changeSet.mergeStartedAt, changeSet.mergedAt, 0);
      if (ms !== null && ms > 0) merge.push(ms);
    }
  }
  return { review, merge };
}

const IN_REVIEW: ReadonlySet<ChangeSetStatus> = new Set(["captured", "in_review"]);
const BEFORE_MERGE: ReadonlySet<ChangeSetStatus> = new Set([
  "captured",
  "in_review",
  "awaiting_human",
  "changes_requested",
  "conflicted",
  "test_failed",
]);
const MERGING: ReadonlySet<ChangeSetStatus> = new Set(["approved", "integrating"]);

interface Tail {
  lowMs: number;
  highMs: number;
}

/** The least time spent on a stage among the items in it: the one started last ends last. */
function leastSpent(starts: (string | undefined)[], now: number): number {
  const spent = starts
    .map((start) => stageMs(start, undefined, now))
    .filter((ms): ms is number => ms !== null);
  return spent.length === 0 ? 0 : Math.min(...spent);
}

/**
 * Review, merge and verification still ahead after the last task's run, from the stage times
 * this goal already recorded. Reviews run beside the workers, so only the last one lengthens
 * the goal; verification is one agent turn like a review and is sized from review times.
 * Without samples a stage adds nothing, which keeps the estimate a floor.
 */
function stageTail(goal: ProgressGoal, now: number, hasOpenImplement: boolean): Tail {
  const samples = stageSamples(goal);
  const tail: Tail = { lowMs: 0, highMs: 0 };
  const add = (durations: number[], spent: number) => {
    if (durations.length === 0) {
      return;
    }
    tail.lowMs += Math.max(0, Math.min(...durations) - spent);
    tail.highMs += Math.max(0, Math.max(...durations) - spent);
  };
  const live = goal.changeSets.filter((changeSet) => changeSet.status !== "superseded");
  const reviewing = live.filter((changeSet) => IN_REVIEW.has(changeSet.status));
  if (hasOpenImplement) {
    add(samples.review, 0);
  } else if (reviewing.length > 0) {
    add(
      samples.review,
      leastSpent(
        reviewing.map((changeSet) => changeSet.reviewStartedAt),
        now,
      ),
    );
  }
  const merging = live.filter((changeSet) => MERGING.has(changeSet.status));
  if (hasOpenImplement || live.some((changeSet) => BEFORE_MERGE.has(changeSet.status))) {
    add(samples.merge, 0);
  } else if (merging.length > 0) {
    add(
      samples.merge,
      leastSpent(
        merging.map((changeSet) => changeSet.mergeStartedAt),
        now,
      ),
    );
  }
  if (goal.criteria.length > 0 && !goal.verifiedAt) {
    add(samples.review, leastSpent([goal.verifyStartedAt], now));
  }
  return tail;
}

/**
 * Time left, as a range: the fastest and slowest finished tasks spread over the goal's
 * parallelism, then the review, merge and verification still ahead, sized from the stage times
 * this goal recorded. A host without stage times leaves those out, so read the range as a floor.
 */
export function estimateRemaining(goal: ProgressGoal, now: number): GoalEstimate {
  if (ENDED.has(goal.status) || !goal.config || goal.tasks.length === 0) {
    return { kind: "none" };
  }
  if (goal.pausedAt) {
    return { kind: "paused" };
  }
  const samples = goal.tasks
    .filter((task) => task.status === "succeeded")
    .map((task) => taskDurationMs(goal, task, now))
    .filter((ms): ms is number => ms !== null && ms > 0);
  if (samples.length < MIN_SAMPLES_FOR_ESTIMATE) {
    return { kind: "estimating", samples: samples.length };
  }
  const fastest = Math.min(...samples);
  const slowest = Math.max(...samples);
  const open = goal.tasks.filter(
    (task) => task.status === "pending" || task.status === "running" || task.status === "failed",
  );
  const tail = stageTail(
    goal,
    now,
    open.some((task) => task.kind === "implement"),
  );
  const parallel = Math.max(
    1,
    Math.min(goal.config.maxParallel, DAEMON_WORKER_LIMIT, Math.max(1, open.length)),
  );
  let lowWork = 0;
  let highWork = 0;
  for (const task of open) {
    const spent = task.status === "running" ? (taskDurationMs(goal, task, now) ?? 0) : 0;
    lowWork += Math.max(0, fastest - spent);
    highWork += Math.max(0, slowest - spent);
  }
  return {
    kind: "range",
    lowMs: roundEstimate(lowWork / parallel + tail.lowMs, "down"),
    highMs: roundEstimate(highWork / parallel + tail.highMs, "up"),
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Whole minutes under an hour, five-minute steps above: an estimate shows no more than it knows. */
function roundEstimate(ms: number, direction: "down" | "up"): number {
  const unit = ms < HOUR_MS ? MINUTE_MS : 5 * MINUTE_MS;
  const round = direction === "down" ? Math.floor : Math.ceil;
  return round(ms / unit) * unit;
}

/** 950 → "950", 12_300 → "12.3k", 4_500_000 → "4.5M". */
export function formatCompactCount(value: number): string {
  const abs = Math.abs(value);
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = value / size;
      const digits = Math.abs(scaled) >= 100 ? 0 : 1;
      return `${Number(scaled.toFixed(digits))}${suffix}`;
    }
  }
  return String(Math.round(value));
}

/**
 * A retry must choose how the time limit restarts (`goalTimeBase`) once the limit has passed.
 * Not when an absolute deadline has passed too: no mode moves it, so the host's refusal says so.
 */
export function retryNeedsTimeMode(goal: DeadlineGoal, now: number): boolean {
  const start = timeLimitStart(goal);
  if (!goal.config || start === null) {
    return false;
  }
  const explicitEnd = absoluteDeadlineMs(goal);
  if (explicitEnd !== null && explicitEnd <= now) {
    return false;
  }
  return timeLimitEndMs(goal, now) <= now;
}

/**
 * Time a `remaining` retry would leave: the time limit minus the time the goal ran, from its
 * event history, as the host computes it. Null for a manual goal.
 */
export function goalRemainingRunMs(
  goal: DeadlineGoal,
  events: readonly GoalEvent[],
  now: number,
): number | null {
  if (!goal.config) {
    return null;
  }
  // The active time already leaves out the time spent waiting for a person.
  return goalTimeoutMs(goal) - goalActiveMs(events, now);
}

/** US dollars, cents under a hundred. */
export function formatUsd(value: number): string {
  return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
}

export type GoalDeadline =
  | { kind: "none" }
  | { kind: "running"; remainingMs: number; totalMs: number; usedFraction: number }
  | { kind: "overdue"; overdueMs: number };

type DeadlineGoal = Pick<Goal, "createdAt" | "timeBaseAt" | "config" | "waits">;

/** When the time limit counts from: where a retry restarted it, else creation. */
function timeLimitStart(goal: DeadlineGoal): number | null {
  return parseTime(goal.timeBaseAt ?? goal.createdAt);
}

/** Time left before the goal timeout fails the goal. */
export function goalDeadline(goal: ProgressGoal, now: number): GoalDeadline {
  const start = timeLimitStart(goal);
  if (ENDED.has(goal.status) || !goal.config || start === null) {
    return { kind: "none" };
  }
  // The earlier of the timeout and an explicit deadline wins. The timeout moves out while an
  // agent waits for a person; the explicit deadline never does.
  const end = goalDeadlineMs(goal, now);
  const totalMs = Math.max(1, end - start);
  const elapsed = Math.max(0, now - start);
  const remainingMs = end - Math.max(now, start);
  if (remainingMs < 0) {
    return { kind: "overdue", overdueMs: -remainingMs };
  }
  return { kind: "running", remainingMs, totalMs, usedFraction: elapsed / totalMs };
}

export type BudgetStatus =
  | { kind: "not_reported" }
  | { kind: "unlimited"; used: number }
  | { kind: "limited"; used: number; limit: number; fraction: number; isOver: boolean };

/** Usage against a limit. `null` usage means nobody reported it, which is not zero. */
export function budgetStatus(used: number | null, limit: number | null): BudgetStatus {
  if (used === null || !Number.isFinite(used)) {
    return { kind: "not_reported" };
  }
  const safeUsed = Math.max(0, used);
  if (limit === null || limit <= 0) {
    return { kind: "unlimited", used: safeUsed };
  }
  return {
    kind: "limited",
    used: safeUsed,
    limit,
    fraction: Math.min(1, safeUsed / limit),
    isOver: safeUsed >= limit,
  };
}

/** Usage per hour of elapsed time, or null when there is nothing to divide. */
export function burnRatePerHour(used: number | null, elapsedMs: number): number | null {
  if (used === null || elapsedMs <= 0) {
    return null;
  }
  return (Math.max(0, used) / elapsedMs) * 3_600_000;
}

export type TimelineStageKind = "review" | "merge";

/** A review or merge window of one of the task's change sets, on the same span as its bar. */
export interface TimelineStage {
  kind: TimelineStageKind;
  offset: number;
  width: number;
  durationMs: number;
}

export interface TaskTimelineBar {
  taskId: string;
  /** Where the task's first run started, 0 to 1 across the goal's span. */
  offset: number;
  /** How much of the span it ran, 0 to 1; zero before it starts. */
  width: number;
  durationMs: number | null;
  attempts: number;
  reworkRound: number | null;
  /** Review and merge windows, in time order; empty for hosts without stage times. */
  stages: TimelineStage[];
}

/** Places a window that started at `start` and lasted `durationMs` on a span. */
function placeOnSpan(
  start: number,
  durationMs: number,
  goalStart: number,
  span: number,
): { offset: number; width: number } {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const offset = clamp((start - goalStart) / span);
  return { offset, width: Math.min(1 - offset, clamp(durationMs / span)) };
}

function changeSetStages(
  changeSets: readonly ChangeSet[],
  now: number,
  goalStart: number,
  span: number,
): TimelineStage[] {
  const stages: TimelineStage[] = [];
  const push = (
    kind: TimelineStageKind,
    start: string | undefined,
    end: string | undefined,
    isOpen: boolean,
  ) => {
    const from = parseTime(start);
    // A window that has neither ended nor is still going was cut short; leave it out.
    if (from === null || (!end && !isOpen)) {
      return;
    }
    const durationMs = stageMs(start, end, now) ?? 0;
    stages.push({ kind, durationMs, ...placeOnSpan(from, durationMs, goalStart, span) });
  };
  for (const changeSet of changeSets) {
    push(
      "review",
      changeSet.reviewStartedAt,
      changeSet.reviewedAt,
      changeSet.status === "in_review",
    );
    push("merge", changeSet.mergeStartedAt, changeSet.mergedAt, changeSet.status === "integrating");
  }
  return stages.sort((a, b) => a.offset - b.offset);
}

/**
 * One bar per task over the goal's life, for a small Gantt-like view. Times before the goal's
 * creation (clock skew between hosts) are clamped to its start.
 */
export function buildTaskTimeline(goal: ProgressGoal, now: number): TaskTimelineBar[] {
  const goalStart = parseTime(goal.createdAt) ?? now;
  const span = Math.max(1, goalElapsedMs(goal, now));
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return goal.tasks.map((task) => {
    const starts = runsOf(goal, task.id)
      .map((run) => parseTime(run.startedAt))
      .filter((t): t is number => t !== null);
    const durationMs = taskDurationMs(goal, task, now);
    const offset = starts.length === 0 ? 0 : clamp((Math.min(...starts) - goalStart) / span);
    const width = durationMs === null ? 0 : Math.min(1 - offset, clamp(durationMs / span));
    const changeSets = goal.changeSets.filter((changeSet) => changeSet.taskId === task.id);
    return {
      taskId: task.id,
      offset,
      width,
      durationMs,
      attempts: task.attempts,
      reworkRound: task.rework?.round ?? null,
      stages: changeSetStages(changeSets, now, goalStart, span),
    };
  });
}

export interface VerificationBar {
  offset: number;
  width: number;
  durationMs: number;
  isRunning: boolean;
}

/** The verification window on the goal's span, once it has started. */
export function buildVerificationBar(goal: ProgressGoal, now: number): VerificationBar | null {
  const from = parseTime(goal.verifyStartedAt);
  if (from === null) {
    return null;
  }
  const goalStart = parseTime(goal.createdAt) ?? now;
  const span = Math.max(1, goalElapsedMs(goal, now));
  const isRunning = !goal.verifiedAt && !ENDED.has(goal.status);
  const end = goal.verifiedAt ?? (isRunning ? undefined : goal.updatedAt);
  const durationMs = stageMs(goal.verifyStartedAt, end, now) ?? 0;
  return { durationMs, isRunning, ...placeOnSpan(from, durationMs, goalStart, span) };
}

/** Tokens a task's runs reported, or null when none did. */
export function taskTokens(goal: Pick<Goal, "runs">, taskId: string): number | null {
  const reported = runsOf(goal, taskId).filter(
    (run) => run.usage !== undefined && run.usage.reportedTurns > 0,
  );
  if (reported.length === 0) {
    return null;
  }
  return reported.reduce((sum, run) => sum + (run.usage?.totalTokens ?? 0), 0);
}
