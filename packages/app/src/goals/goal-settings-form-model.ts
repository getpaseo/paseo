import { goalPermissionPolicy } from "@getpaseo/protocol/goal/config-bounds";
import type { GoalConfig, GoalConfigChanges } from "@getpaseo/protocol/goal/types";
import {
  DAEMON_GOAL_SETTINGS,
  GOAL_BUDGET_RANGES,
  GOAL_SETTING_RANGES,
  goalPermissionPolicyOptions,
  type GoalBudget,
  type GoalBudgetKey,
  type GoalNumberSetting,
  type GoalPermissionPolicy,
  type GoalSettings,
} from "./goal-settings";

/** The settings of a goal that `goal.update_config` can change, as the edit form holds them. */
export interface GoalSettingsEditValues {
  settings: GoalSettings;
  budget: GoalBudget;
  /** Empty is no test command. */
  testCommand: string;
}

/** A field absent from the config holds the value the daemon runs it with. */
export function goalSettingsEditValues(config: GoalConfig): GoalSettingsEditValues {
  const limits = config.limits ?? {};
  const defaults = DAEMON_GOAL_SETTINGS;
  return {
    settings: {
      maxParallel: config.maxParallel,
      maxAttempts: config.maxAttempts,
      maxReworkRounds: config.maxReworkRounds ?? defaults.maxReworkRounds,
      maxTasks: limits.maxTasks ?? defaults.maxTasks,
      maxRuns: limits.maxRuns ?? defaults.maxRuns,
      runTimeoutMinutes: limits.runTimeoutMinutes ?? defaults.runTimeoutMinutes,
      goalTimeoutMinutes: limits.goalTimeoutMinutes ?? defaults.goalTimeoutMinutes,
      retryBackoffSeconds: limits.retryBackoffSeconds ?? defaults.retryBackoffSeconds,
      userWaitMinutes: limits.userWaitMinutes ?? defaults.userWaitMinutes,
      autoApprovePlan: config.autoApprovePlan,
      requireHumanApproval: config.requireHumanApproval ?? false,
      // A goal stored without a policy runs as `fail`; show what it runs with.
      onPermissionRequest: goalPermissionPolicy(config),
      notifyLead: config.notifyLead,
    },
    budget: {
      maxTotalTokens: limits.maxTotalTokens ?? null,
      maxCostUsd: limits.maxCostUsd ?? null,
    },
    testCommand: config.testCommand ?? "",
  };
}

const TOP_LEVEL_NUMBERS = ["maxParallel", "maxAttempts", "maxReworkRounds"] as const;
const LIMIT_NUMBERS = [
  "maxTasks",
  "maxRuns",
  "runTimeoutMinutes",
  "goalTimeoutMinutes",
  "retryBackoffSeconds",
] as const;
const FLAGS = ["autoApprovePlan", "requireHumanApproval", "notifyLead"] as const;
const BUDGET_KEYS: readonly GoalBudgetKey[] = ["maxTotalTokens", "maxCostUsd"];

/**
 * Only what differs from `baseline`, as `goal.update_config` takes it. A cleared budget or test
 * command is sent as null. Without `budgetSupported` the caps are never sent, nor is the wait
 * limit without `userWaitSupported`.
 */
export function goalConfigChanges(
  baseline: GoalSettingsEditValues,
  values: GoalSettingsEditValues,
  options: { budgetSupported: boolean; userWaitSupported: boolean },
): GoalConfigChanges {
  const changes: GoalConfigChanges = {};
  const limits: NonNullable<GoalConfigChanges["limits"]> = {};
  for (const key of TOP_LEVEL_NUMBERS) {
    if (values.settings[key] !== baseline.settings[key]) {
      changes[key] = values.settings[key];
    }
  }
  for (const key of FLAGS) {
    if (values.settings[key] !== baseline.settings[key]) {
      changes[key] = values.settings[key];
    }
  }
  if (values.settings.onPermissionRequest !== baseline.settings.onPermissionRequest) {
    changes.onPermissionRequest = values.settings.onPermissionRequest;
  }
  for (const key of LIMIT_NUMBERS) {
    if (values.settings[key] !== baseline.settings[key]) {
      limits[key] = values.settings[key];
    }
  }
  if (
    options.userWaitSupported &&
    values.settings.userWaitMinutes !== baseline.settings.userWaitMinutes
  ) {
    limits.userWaitMinutes = values.settings.userWaitMinutes;
  }
  if (options.budgetSupported) {
    for (const key of BUDGET_KEYS) {
      if (values.budget[key] !== baseline.budget[key]) {
        limits[key] = values.budget[key];
      }
    }
  }
  const testCommand = values.testCommand.trim();
  if (testCommand !== baseline.testCommand.trim()) {
    changes.testCommand = testCommand || null;
  }
  if (Object.keys(limits).length > 0) {
    changes.limits = limits;
  }
  return changes;
}

export type GoalSettingsEditField = GoalNumberSetting | GoalBudgetKey;

export interface GoalSettingsEditIssue {
  field: GoalSettingsEditField;
  code: "range";
  min: number;
  max: number;
}

function outOfRange(value: number, range: { min: number; max: number }, integer: boolean): boolean {
  return (
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value)) ||
    value < range.min ||
    value > range.max
  );
}

/** Numbers the daemon would refuse; the number fields already hold typed text to their range. */
export function validateGoalSettingsEdit(values: GoalSettingsEditValues): GoalSettingsEditIssue[] {
  const issues: GoalSettingsEditIssue[] = [];
  for (const key of Object.keys(GOAL_SETTING_RANGES) as GoalNumberSetting[]) {
    const range = GOAL_SETTING_RANGES[key];
    if (outOfRange(values.settings[key], range, true)) {
      issues.push({ field: key, code: "range", ...range });
    }
  }
  for (const key of BUDGET_KEYS) {
    const value = values.budget[key];
    const range = GOAL_BUDGET_RANGES[key];
    if (value !== null && outOfRange(value, range, key === "maxTotalTokens")) {
      issues.push({ field: key, code: "range", ...range });
    }
  }
  return issues;
}

export interface GoalSettingsFormSnapshot {
  config: GoalConfig;
  /** The host enforces token and cost caps (`goalBudgets`). */
  budgetSupported: boolean;
  /** The host takes the `auto` policy (`goalConfigEdit`). */
  autoPermissionSupported: boolean;
  /** The host takes `userWaitMinutes` (`goalUserWait`). */
  userWaitSupported: boolean;
}

export interface GoalSettingsFormState {
  values: GoalSettingsEditValues;
  /** The goal's settings as the host last reported them. */
  baseline: GoalSettingsEditValues;
  budgetSupported: boolean;
  userWaitSupported: boolean;
  policyOptions: GoalPermissionPolicy[];
  changes: GoalConfigChanges;
  hasChanges: boolean;
  issues: GoalSettingsEditIssue[];
  canSave: boolean;
  submitError: string | null;
}

export interface GoalSettingsFormModel {
  getState: () => GoalSettingsFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setSetting: <Key extends keyof GoalSettings>(key: Key, value: GoalSettings[Key]) => void;
  /** Null is no cap. */
  setBudget: (key: GoalBudgetKey, value: number | null) => void;
  setTestCommand: (value: string) => void;
  /**
   * Late data: the goal's config changed on the host. Fields you have not changed follow it;
   * the ones you changed keep your value.
   */
  applyConfig: (config: GoalConfig) => void;
  setSubmitError: (message: string | null) => void;
}

type BaseState = Pick<
  GoalSettingsFormState,
  "values" | "baseline" | "budgetSupported" | "userWaitSupported" | "policyOptions" | "submitError"
>;

function withDerived(state: BaseState): GoalSettingsFormState {
  const changes = goalConfigChanges(state.baseline, state.values, {
    budgetSupported: state.budgetSupported,
    userWaitSupported: state.userWaitSupported,
  });
  const issues = validateGoalSettingsEdit(state.values);
  const hasChanges = Object.keys(changes).length > 0;
  return { ...state, changes, hasChanges, issues, canSave: hasChanges && issues.length === 0 };
}

/** Each field: yours when you changed it from the old baseline, else the new baseline's. */
function rebase<T extends object>(values: T, oldBaseline: T, newBaseline: T): T {
  const next = { ...newBaseline };
  for (const key of Object.keys(values) as (keyof T)[]) {
    if (values[key] !== oldBaseline[key]) {
      next[key] = values[key];
    }
  }
  return next;
}

export function openGoalSettingsForm(snapshot: GoalSettingsFormSnapshot): GoalSettingsFormModel {
  const listeners = new Set<() => void>();
  let closed = false;
  const baseline = goalSettingsEditValues(snapshot.config);
  let state = withDerived({
    values: baseline,
    baseline,
    budgetSupported: snapshot.budgetSupported,
    userWaitSupported: snapshot.userWaitSupported,
    policyOptions: goalPermissionPolicyOptions(snapshot.autoPermissionSupported),
    submitError: null,
  });

  function publish(next: BaseState): void {
    if (closed) {
      return;
    }
    state = withDerived(next);
    for (const listener of listeners) {
      listener();
    }
  }

  function setValues(values: GoalSettingsEditValues): void {
    publish({ ...state, values, submitError: null });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (closed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    setSetting(key, value) {
      setValues({ ...state.values, settings: { ...state.values.settings, [key]: value } });
    },
    setBudget(key, value) {
      setValues({ ...state.values, budget: { ...state.values.budget, [key]: value } });
    },
    setTestCommand(value) {
      setValues({ ...state.values, testCommand: value });
    },
    applyConfig(config) {
      const next = goalSettingsEditValues(config);
      const old = state.baseline;
      const sameText = state.values.testCommand.trim() === old.testCommand.trim();
      publish({
        ...state,
        baseline: next,
        values: {
          settings: rebase(state.values.settings, old.settings, next.settings),
          budget: rebase(state.values.budget, old.budget, next.budget),
          testCommand: sameText ? next.testCommand : state.values.testCommand,
        },
      });
    },
    setSubmitError(message) {
      publish({ ...state, submitError: message });
    },
  };
}
