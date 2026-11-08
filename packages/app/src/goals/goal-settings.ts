import {
  DEFAULT_GOAL_PERMISSION_POLICY,
  GOAL_CONFIG_BOUNDS,
  type GoalPermissionPolicy,
} from "@getpaseo/protocol/goal/config-bounds";
import { goalRoleProvider, goalRoleThinking } from "@getpaseo/protocol/goal/thinking";
import type { GoalConfig } from "@getpaseo/protocol/goal/types";

export type { GoalPermissionPolicy };

/**
 * The policies to offer, safest first. `auto` needs a host with `goalConfigEdit`: an older
 * daemon's schema rejects it.
 */
export function goalPermissionPolicyOptions(autoSupported: boolean): GoalPermissionPolicy[] {
  return autoSupported ? ["wait", "auto", "fail"] : ["wait", "fail"];
}

/** Settings the host can take: a remembered `auto` becomes `wait` on a host without it. */
export function supportedGoalSettings(
  settings: GoalSettings,
  autoSupported: boolean,
): GoalSettings {
  return !autoSupported && settings.onPermissionRequest === "auto"
    ? { ...settings, onPermissionRequest: "wait" }
    : settings;
}

/** Every tunable knob of a managed goal except who does the work and where. */
export interface GoalSettings {
  maxParallel: number;
  maxAttempts: number;
  maxReworkRounds: number;
  maxTasks: number;
  maxRuns: number;
  runTimeoutMinutes: number;
  goalTimeoutMinutes: number;
  retryBackoffSeconds: number;
  /** Needs a host with `goalUserWait`; without it the value is neither shown nor sent. */
  userWaitMinutes: number;
  autoApprovePlan: boolean;
  requireHumanApproval: boolean;
  onPermissionRequest: GoalPermissionPolicy;
  notifyLead: boolean;
}

export type GoalNumberSetting = {
  [Key in keyof GoalSettings]: GoalSettings[Key] extends number ? Key : never;
}[keyof GoalSettings];

export interface GoalSettingRange {
  min: number;
  max: number;
}

const BOUNDS = GOAL_CONFIG_BOUNDS;

function rangeOf(bound: GoalSettingRange): GoalSettingRange {
  return { min: bound.min, max: bound.max };
}

/** From the protocol's bounds, so the form can never offer a value the daemon refuses. */
export const GOAL_SETTING_RANGES: Record<GoalNumberSetting, GoalSettingRange> = {
  maxParallel: rangeOf(BOUNDS.maxParallel),
  maxAttempts: rangeOf(BOUNDS.maxAttempts),
  maxReworkRounds: rangeOf(BOUNDS.maxReworkRounds),
  maxTasks: rangeOf(BOUNDS.limits.maxTasks),
  maxRuns: rangeOf(BOUNDS.limits.maxRuns),
  runTimeoutMinutes: rangeOf(BOUNDS.limits.runTimeoutMinutes),
  goalTimeoutMinutes: rangeOf(BOUNDS.limits.goalTimeoutMinutes),
  retryBackoffSeconds: rangeOf(BOUNDS.limits.retryBackoffSeconds),
  userWaitMinutes: rangeOf(BOUNDS.limits.userWaitMinutes),
};

/** What the daemon uses when a field is left out. */
export const DAEMON_GOAL_SETTINGS: GoalSettings = {
  maxParallel: BOUNDS.maxParallel.default,
  maxAttempts: BOUNDS.maxAttempts.default,
  maxReworkRounds: BOUNDS.maxReworkRounds.default,
  maxTasks: BOUNDS.limits.maxTasks.default,
  maxRuns: BOUNDS.limits.maxRuns.default,
  runTimeoutMinutes: BOUNDS.limits.runTimeoutMinutes.default,
  goalTimeoutMinutes: BOUNDS.limits.goalTimeoutMinutes.default,
  retryBackoffSeconds: BOUNDS.limits.retryBackoffSeconds.default,
  userWaitMinutes: BOUNDS.limits.userWaitMinutes.default,
  autoApprovePlan: false,
  requireHumanApproval: false,
  onPermissionRequest: DEFAULT_GOAL_PERMISSION_POLICY,
  notifyLead: true,
};

/** Spending caps. Null is no cap. Kept apart from the presets: they depend on your providers. */
export interface GoalBudget {
  maxTotalTokens: number | null;
  maxCostUsd: number | null;
}

export type GoalBudgetKey = keyof GoalBudget;

export const NO_GOAL_BUDGET: GoalBudget = { maxTotalTokens: null, maxCostUsd: null };

const BUDGET_STEPS: Record<GoalBudgetKey, readonly number[]> = {
  maxTotalTokens: [
    100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000,
    100_000_000,
  ],
  maxCostUsd: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
};

/** From the protocol's bounds, like `GOAL_SETTING_RANGES`. */
export const GOAL_BUDGET_RANGES: Record<GoalBudgetKey, GoalSettingRange> = {
  maxTotalTokens: rangeOf(BOUNDS.limits.maxTotalTokens),
  maxCostUsd: rangeOf(BOUNDS.limits.maxCostUsd),
};

/** The round caps a budget stepper walks. */
export function goalBudgetSteps(key: GoalBudgetKey): number[] {
  const range = GOAL_BUDGET_RANGES[key];
  return BUDGET_STEPS[key].filter((step) => step >= range.min && step <= range.max);
}

/** The next cap up or down. Below the smallest cap is no cap. */
export function stepGoalBudget(
  key: GoalBudgetKey,
  value: number | null,
  direction: 1 | -1,
): number | null {
  const steps = goalBudgetSteps(key);
  if (value === null) {
    return direction === 1 ? (steps[0] ?? null) : null;
  }
  if (direction === 1) {
    return steps.find((step) => step > value) ?? steps[steps.length - 1] ?? value;
  }
  const lower = steps.filter((step) => step < value);
  return lower[lower.length - 1] ?? null;
}

/** The budget as `limits` fields; only caps that are set. */
export function goalBudgetToLimits(
  budget: GoalBudget,
): Pick<NonNullable<GoalConfig["limits"]>, "maxTotalTokens" | "maxCostUsd"> {
  return {
    ...(budget.maxTotalTokens !== null ? { maxTotalTokens: budget.maxTotalTokens } : {}),
    ...(budget.maxCostUsd !== null ? { maxCostUsd: budget.maxCostUsd } : {}),
  };
}

export type GoalPresetId = "careful" | "balanced" | "turbo";

export const GOAL_PRESET_IDS: readonly GoalPresetId[] = ["careful", "balanced", "turbo"];

export const GOAL_PRESETS: Record<GoalPresetId, GoalSettings> = {
  careful: {
    ...DAEMON_GOAL_SETTINGS,
    maxParallel: 1,
    maxReworkRounds: 1,
    maxTasks: 10,
    maxRuns: 20,
    runTimeoutMinutes: 30,
    goalTimeoutMinutes: 240,
    requireHumanApproval: true,
    onPermissionRequest: "wait",
  },
  balanced: DAEMON_GOAL_SETTINGS,
  turbo: {
    ...DAEMON_GOAL_SETTINGS,
    maxParallel: 4,
    maxAttempts: 3,
    maxReworkRounds: 3,
    maxTasks: 40,
    maxRuns: 120,
    runTimeoutMinutes: 90,
    goalTimeoutMinutes: 720,
    autoApprovePlan: true,
  },
};

/** A preset, your remembered settings, or anything else. */
export type GoalSettingsChoice = GoalPresetId | "mine" | "custom";

export function sameGoalSettings(a: GoalSettings, b: GoalSettings): boolean {
  return (Object.keys(a) as (keyof GoalSettings)[]).every((key) => a[key] === b[key]);
}

export function matchGoalSettingsChoice(
  settings: GoalSettings,
  personal: GoalSettings | null,
): GoalSettingsChoice {
  const preset = GOAL_PRESET_IDS.find((id) => sameGoalSettings(settings, GOAL_PRESETS[id]));
  if (preset) {
    return preset;
  }
  if (personal && sameGoalSettings(settings, personal)) {
    return "mine";
  }
  return "custom";
}

/** Friendly steps for the duration steppers, in minutes. */
const DURATION_STEPS_MINUTES = [
  1, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1080, 1440, 2160, 2880, 4320,
  5760, 7200, 8640, 10080,
];
const BACKOFF_STEPS_SECONDS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** The ladder a stepper walks. Plain counts move by one; durations jump between round values. */
export function goalSettingSteps(setting: GoalNumberSetting): number[] | null {
  const range = GOAL_SETTING_RANGES[setting];
  const within = (value: number) => value >= range.min && value <= range.max;
  if (
    setting === "runTimeoutMinutes" ||
    setting === "goalTimeoutMinutes" ||
    setting === "userWaitMinutes"
  ) {
    return DURATION_STEPS_MINUTES.filter(within);
  }
  if (setting === "retryBackoffSeconds") {
    return BACKOFF_STEPS_SECONDS.filter(within);
  }
  return null;
}

/** The next value up or down from `value`, held inside the range. */
export function stepGoalSetting(
  setting: GoalNumberSetting,
  value: number,
  direction: 1 | -1,
): number {
  const range = GOAL_SETTING_RANGES[setting];
  const steps = goalSettingSteps(setting);
  if (!steps) {
    return Math.min(range.max, Math.max(range.min, value + direction));
  }
  if (direction === 1) {
    return steps.find((step) => step > value) ?? steps[steps.length - 1] ?? value;
  }
  const lower = steps.filter((step) => step < value);
  return lower[lower.length - 1] ?? steps[0] ?? value;
}

export type DurationUnit = "seconds" | "minutes" | "hours" | "days";

export interface DurationParts {
  unit: DurationUnit;
  n: number;
}

/** The largest whole unit: 90 → 90 minutes, 120 → 2 hours, 2880 → 2 days. */
export function minutesToDuration(minutes: number): DurationParts {
  if (minutes > 0 && minutes % 1440 === 0) {
    return { unit: "days", n: minutes / 1440 };
  }
  if (minutes > 0 && minutes % 60 === 0) {
    return { unit: "hours", n: minutes / 60 };
  }
  return { unit: "minutes", n: minutes };
}

export function secondsToDuration(seconds: number): DurationParts {
  if (seconds > 0 && seconds % 60 === 0) {
    return minutesToDuration(seconds / 60);
  }
  return { unit: "seconds", n: seconds };
}

export type GoalSettingsSummaryPart =
  | { key: "parallel"; n: number }
  | { key: "runLimit"; duration: DurationParts }
  | { key: "deadline"; duration: DurationParts }
  | { key: "approvesPlan" | "asksPlan" | "asksMerge" | "mergesReviewed" | "runsTests" }
  /** A permission policy other than the default `wait`. */
  | { key: "autoPermission" | "failsPermission" }
  /** A role whose thinking level is set; `label` is the option's display label. */
  | { key: "thinking"; role: GoalThinkingRole; label: string };

/** The settings as a few clauses, read top to bottom as one sentence under the form. */
export function summarizeGoalSettings(
  settings: GoalSettings,
  extra: { hasTestCommand: boolean },
): GoalSettingsSummaryPart[] {
  const parts: GoalSettingsSummaryPart[] = [
    { key: "parallel", n: settings.maxParallel },
    { key: "runLimit", duration: minutesToDuration(settings.runTimeoutMinutes) },
    { key: "deadline", duration: minutesToDuration(settings.goalTimeoutMinutes) },
    { key: settings.autoApprovePlan ? "approvesPlan" : "asksPlan" },
    { key: settings.requireHumanApproval ? "asksMerge" : "mergesReviewed" },
  ];
  if (extra.hasTestCommand) {
    parts.push({ key: "runsTests" });
  }
  if (settings.onPermissionRequest === "auto") {
    parts.push({ key: "autoPermission" });
  } else if (settings.onPermissionRequest === "fail") {
    parts.push({ key: "failsPermission" });
  }
  return parts;
}

type LimitSetting = Extract<
  GoalNumberSetting,
  "maxTasks" | "maxRuns" | "runTimeoutMinutes" | "goalTimeoutMinutes" | "retryBackoffSeconds"
>;

const LIMIT_SETTINGS: readonly LimitSetting[] = [
  "maxTasks",
  "maxRuns",
  "runTimeoutMinutes",
  "goalTimeoutMinutes",
  "retryBackoffSeconds",
];

export type GoalSettingsConfig = Pick<
  GoalConfig,
  | "maxParallel"
  | "maxAttempts"
  | "autoApprovePlan"
  | "notifyLead"
  | "requireHumanApproval"
  | "maxReworkRounds"
  | "limits"
  | "onPermissionRequest"
>;

/**
 * The settings as `GoalConfig` fields. Optional fields equal to the daemon's default are left
 * out, so the daemon keeps owning its defaults. The permission policy is the exception: a daemon
 * from before `wait` became the default runs a goal without one as `fail`.
 */
export function goalSettingsToConfig(
  settings: GoalSettings,
  options: { userWaitSupported?: boolean } = {},
): GoalSettingsConfig {
  const limits: NonNullable<GoalConfig["limits"]> = {};
  for (const key of LIMIT_SETTINGS) {
    if (settings[key] !== DAEMON_GOAL_SETTINGS[key]) {
      limits[key] = settings[key];
    }
  }
  // A host without `goalUserWait` would refuse the field, so it is sent only to one that has it.
  if (
    options.userWaitSupported &&
    settings.userWaitMinutes !== DAEMON_GOAL_SETTINGS.userWaitMinutes
  ) {
    limits.userWaitMinutes = settings.userWaitMinutes;
  }
  const hasLimits = Object.keys(limits).length > 0;
  const changedRework = settings.maxReworkRounds !== DAEMON_GOAL_SETTINGS.maxReworkRounds;
  return {
    maxParallel: settings.maxParallel,
    maxAttempts: settings.maxAttempts,
    autoApprovePlan: settings.autoApprovePlan,
    notifyLead: settings.notifyLead,
    ...(settings.requireHumanApproval ? { requireHumanApproval: true } : {}),
    ...(changedRework ? { maxReworkRounds: settings.maxReworkRounds } : {}),
    ...(hasLimits ? { limits } : {}),
    onPermissionRequest: settings.onPermissionRequest,
  };
}

/** Clamps every number into its range, so stored or prefilled settings are always sendable. */
export function normalizeGoalSettings(input: Partial<GoalSettings>): GoalSettings {
  const settings: GoalSettings = { ...DAEMON_GOAL_SETTINGS, ...input };
  for (const key of Object.keys(GOAL_SETTING_RANGES) as GoalNumberSetting[]) {
    const range = GOAL_SETTING_RANGES[key];
    const value = Math.round(settings[key]);
    settings[key] = Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : 0;
  }
  return settings;
}

/** The roles of a goal that each start agents with their own thinking level. */
export type GoalThinkingRole = "lead" | "worker" | "reviewer" | "verifier";

export const GOAL_THINKING_ROLES: readonly GoalThinkingRole[] = [
  "lead",
  "worker",
  "reviewer",
  "verifier",
];

export interface GoalTeamRole {
  role: GoalThinkingRole;
  /** `provider` or `provider/model`, as the daemon starts it. */
  provider: string;
  /** The thinking option asked for; null leaves the model's default. */
  thinking: string | null;
}

/**
 * Who runs each role of a managed goal and with what thinking, read from its config. Workers are
 * the ones on `defaultProvider`; a task that names another provider keeps its own setting.
 */
export function goalTeam(config: GoalConfig): GoalTeamRole[] {
  return GOAL_THINKING_ROLES.map((role) => ({
    role,
    provider: goalRoleProvider(config, role),
    thinking: goalRoleThinking(config, role) ?? null,
  }));
}
