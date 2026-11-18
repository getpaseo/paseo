/**
 * Ranges and defaults for goal settings, in one place for the schema, the daemon,
 * the CLI and the app's create form. A default of `null` means "off" or "none".
 */
export interface GoalNumberBound {
  min: number;
  max: number;
  default: number | null;
}

export const GOAL_CONFIG_BOUNDS = {
  maxParallel: { min: 1, max: 8, default: 2 },
  maxAttempts: { min: 1, max: 5, default: 2 },
  maxReworkRounds: { min: 0, max: 5, default: 2 },
  limits: {
    maxTasks: { min: 1, max: 100, default: 25 },
    maxRuns: { min: 1, max: 500, default: 60 },
    runTimeoutMinutes: { min: 1, max: 1440, default: 60 },
    goalTimeoutMinutes: { min: 1, max: 10080, default: 1440 },
    // Longest one permission request or question waits for a person's answer.
    userWaitMinutes: { min: 5, max: 10080, default: 720 },
    retryBackoffSeconds: { min: 0, max: 3600, default: 5 },
    // Fresh input plus output tokens the providers report, over the goal's life; cache
    // reads are not counted. See UsageTotalsSchema.
    maxTotalTokens: { min: 1000, max: 10_000_000_000, default: null },
    // US dollars the providers report, over the goal's life.
    maxCostUsd: { min: 0.01, max: 100_000, default: null },
  },
} as const satisfies {
  maxParallel: GoalNumberBound;
  maxAttempts: GoalNumberBound;
  maxReworkRounds: GoalNumberBound;
  limits: Record<string, GoalNumberBound>;
};

/**
 * Daemon-wide goal settings, stored under `daemon.goals` in the daemon config.
 * `maxConcurrentRuns` caps worker runs across all goals at once.
 */
export const GOAL_DAEMON_BOUNDS = {
  maxConcurrentRuns: { min: 1, max: 32, default: 4 },
} as const satisfies Record<string, GoalNumberBound>;

/** Prefix of the integration branch, `<prefix>/<goalId>`. */
export const DEFAULT_GOAL_BRANCH_PREFIX = "paseo-goal";

/** Segments of letters, digits, `.`, `_` and `-`, joined by `/`; no segment starts with `.` or `-`. */
export const GOAL_BRANCH_PREFIX_PATTERN =
  /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
export const GOAL_BRANCH_PREFIX_MAX_LENGTH = 100;

/** What a goal does when one of its agents asks for a permission; see GoalConfig.onPermissionRequest. */
export const GOAL_PERMISSION_POLICIES = ["fail", "wait", "auto"] as const;
export type GoalPermissionPolicy = (typeof GOAL_PERMISSION_POLICIES)[number];

/** Recorded on every goal created without a policy. */
export const DEFAULT_GOAL_PERMISSION_POLICY: GoalPermissionPolicy = "wait";

/**
 * The policy a goal runs under. A config without one was stored before "wait" became
 * the default, when a missing policy meant "fail"; it keeps that meaning.
 */
export function goalPermissionPolicy(
  config: { onPermissionRequest?: GoalPermissionPolicy } | null | undefined,
): GoalPermissionPolicy {
  return config?.onPermissionRequest ?? "fail";
}
