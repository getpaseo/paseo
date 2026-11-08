import { GOAL_CONFIG_BOUNDS } from "./config-bounds.js";
import type { Goal } from "./types.js";

/**
 * When a goal must be finished. The daemon, the CLI and the app all read the time limit
 * through these, so they agree on it. Time an agent of the goal spent waiting for a person's
 * answer is left out of the time limit (`Goal.waits`); the absolute deadline is never moved.
 */

const MINUTE = 60_000;

export type TimeLimitGoal = Pick<Goal, "createdAt" | "timeBaseAt" | "config" | "waits">;

/** The goal's time limit in milliseconds: its own setting, else the default. */
export function goalTimeoutMs(goal: Pick<Goal, "config">): number {
  return (
    (goal.config?.limits?.goalTimeoutMinutes ??
      GOAL_CONFIG_BOUNDS.limits.goalTimeoutMinutes.default) * MINUTE
  );
}

/**
 * Milliseconds, as of `nowMs`, agents of the goal spent waiting for a person's answer since the
 * time base; overlapping waits count once. Includes the wait still open.
 */
export function excludedWaitMs(goal: Pick<Goal, "waits">, nowMs: number): number {
  const waits = goal.waits;
  if (!waits) return 0;
  const since = waits.since === null ? Number.NaN : Date.parse(waits.since);
  return waits.excludedMs + (Number.isNaN(since) ? 0 : Math.max(0, nowMs - since));
}

/**
 * When the time limit runs out, in epoch milliseconds, as of `nowMs`: counted from timeBaseAt,
 * else creation, and pushed back by the time spent waiting for a person. While an agent waits,
 * the end moves with `nowMs`.
 */
export function timeLimitEndMs(goal: TimeLimitGoal, nowMs: number): number {
  return (
    Date.parse(goal.timeBaseAt ?? goal.createdAt) +
    goalTimeoutMs(goal) +
    excludedWaitMs(goal, nowMs)
  );
}

/** The absolute deadline in epoch milliseconds, or null when none is set. */
export function absoluteDeadlineMs(goal: Pick<Goal, "config">): number | null {
  const deadlineAt = goal.config?.limits?.deadlineAt;
  const absolute = deadlineAt ? Date.parse(deadlineAt) : Number.NaN;
  return Number.isNaN(absolute) ? null : absolute;
}

/**
 * When the goal must be finished, in epoch milliseconds, as of `nowMs`: the end of its time
 * limit, or the absolute deadline if that comes first.
 */
export function goalDeadlineMs(goal: TimeLimitGoal, nowMs: number): number {
  const byTimeout = timeLimitEndMs(goal, nowMs);
  const absolute = absoluteDeadlineMs(goal);
  return absolute === null ? byTimeout : Math.min(byTimeout, absolute);
}
