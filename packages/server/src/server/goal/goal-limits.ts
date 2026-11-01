import { GOAL_CONFIG_BOUNDS } from "@getpaseo/protocol/goal/config-bounds";
import type { Goal, GoalConfig, TaskSpec } from "@getpaseo/protocol/goal/types";

// The time limit is read the same way by the daemon, the CLI and the app.
export {
  absoluteDeadlineMs,
  excludedWaitMs,
  goalDeadlineMs,
  timeLimitEndMs,
} from "@getpaseo/protocol/goal/time-limit";

export interface ResolvedLimits {
  maxTasks: number;
  maxRuns: number;
  runTimeoutMs: number;
  goalTimeoutMs: number;
  /** Longest one permission request or question waits for a person's answer. */
  userWaitMs: number;
  retryBackoffMs: number;
  /** Null when no budget is set. */
  maxTotalTokens: number | null;
  maxCostUsd: number | null;
}

const MINUTE = 60_000;
const BOUNDS = GOAL_CONFIG_BOUNDS.limits;

export const DEFAULT_LIMITS: ResolvedLimits = {
  maxTasks: BOUNDS.maxTasks.default,
  maxRuns: BOUNDS.maxRuns.default,
  runTimeoutMs: BOUNDS.runTimeoutMinutes.default * MINUTE,
  goalTimeoutMs: BOUNDS.goalTimeoutMinutes.default * MINUTE,
  userWaitMs: BOUNDS.userWaitMinutes.default * MINUTE,
  retryBackoffMs: BOUNDS.retryBackoffSeconds.default * 1000,
  maxTotalTokens: BOUNDS.maxTotalTokens.default,
  maxCostUsd: BOUNDS.maxCostUsd.default,
};

/** The limits in force for a goal: its own settings over the defaults. */
export function resolveLimits(config: GoalConfig | null | undefined): ResolvedLimits {
  const limits = config?.limits;
  return {
    maxTasks: limits?.maxTasks ?? DEFAULT_LIMITS.maxTasks,
    maxRuns: limits?.maxRuns ?? DEFAULT_LIMITS.maxRuns,
    runTimeoutMs:
      limits?.runTimeoutMinutes === undefined
        ? DEFAULT_LIMITS.runTimeoutMs
        : limits.runTimeoutMinutes * MINUTE,
    goalTimeoutMs:
      limits?.goalTimeoutMinutes === undefined
        ? DEFAULT_LIMITS.goalTimeoutMs
        : limits.goalTimeoutMinutes * MINUTE,
    userWaitMs:
      limits?.userWaitMinutes === undefined
        ? DEFAULT_LIMITS.userWaitMs
        : limits.userWaitMinutes * MINUTE,
    retryBackoffMs:
      limits?.retryBackoffSeconds === undefined
        ? DEFAULT_LIMITS.retryBackoffMs
        : limits.retryBackoffSeconds * 1000,
    maxTotalTokens: limits?.maxTotalTokens ?? DEFAULT_LIMITS.maxTotalTokens,
    maxCostUsd: limits?.maxCostUsd ?? DEFAULT_LIMITS.maxCostUsd,
  };
}

/** Turn time limit for a task's runs: its own limit, which can only lower the goal's. */
export function taskRunTimeoutMs(
  goal: Pick<Goal, "config">,
  task: Pick<TaskSpec, "runTimeoutMinutes">,
): number {
  const goalMs = resolveLimits(goal.config).runTimeoutMs;
  return task.runTimeoutMinutes === undefined
    ? goalMs
    : Math.min(task.runTimeoutMinutes * MINUTE, goalMs);
}

/** The budget the goal has used up, as a reason to stop it, or null while within budget. */
export function budgetExceeded(goal: Pick<Goal, "usage" | "config">): string | null {
  const { maxTotalTokens, maxCostUsd } = resolveLimits(goal.config);
  const usage = goal.usage;
  if (!usage) return null;
  if (maxTotalTokens !== null && usage.totalTokens >= maxTotalTokens) {
    return `Token budget of ${maxTotalTokens} reached (${usage.totalTokens} reported)`;
  }
  if (maxCostUsd !== null && usage.costUsd >= maxCostUsd) {
    return `Cost budget of $${maxCostUsd} reached ($${usage.costUsd.toFixed(2)} reported)`;
  }
  return null;
}

/** Time source the Manager schedules against; tests supply their own. */
export interface Clock {
  now(): number;
  /** Run `fn` after `ms`. Returns a function that cancels it. */
  setTimeout(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    // Waiting on a limit must not keep the daemon alive.
    timer.unref();
    return () => clearTimeout(timer);
  },
};
