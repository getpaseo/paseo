import {
  compactCountFormat,
  durationFormat,
  plainNumberFormat,
  usdFormat,
  type ScrubFormat,
  type ScrubScale,
} from "@/utils/scrub-number";
import {
  GOAL_BUDGET_RANGES,
  GOAL_SETTING_RANGES,
  goalBudgetSteps,
  goalSettingSteps,
  type GoalBudgetKey,
  type GoalNumberSetting,
} from "./goal-settings";

/** How a goal number is typed, shown and scrubbed. */
export interface GoalNumberField {
  scale: ScrubScale;
  format: ScrubFormat;
  /** The touch keyboard: whole numbers get the number pad, dollars the decimal pad. */
  inputMode: "numeric" | "decimal";
}

const COUNT = plainNumberFormat({ integer: true });
const MINUTES = durationFormat("minutes");
const SECONDS = durationFormat("seconds");

function countField(setting: GoalNumberSetting, step = 1): GoalNumberField {
  return {
    scale: { ...GOAL_SETTING_RANGES[setting], step, fineStep: 1 },
    format: COUNT,
    inputMode: "numeric",
  };
}

/** Durations walk the stepper's round values; a fine move is one unit. */
function durationField(setting: GoalNumberSetting, format: ScrubFormat): GoalNumberField {
  return {
    scale: {
      ...GOAL_SETTING_RANGES[setting],
      step: 1,
      fineStep: 1,
      ladder: goalSettingSteps(setting) ?? [],
    },
    format,
    // On touch the number pad has no letters, so you type a bare number in the base unit;
    // a hardware keyboard still takes "2h".
    inputMode: "numeric",
  };
}

export const GOAL_SETTING_FIELDS: Record<GoalNumberSetting, GoalNumberField> = {
  maxParallel: countField("maxParallel"),
  maxAttempts: countField("maxAttempts"),
  maxReworkRounds: countField("maxReworkRounds"),
  // Wide ranges move by round numbers so a drag covers them; Shift or typing reaches the rest.
  maxTasks: countField("maxTasks", 5),
  maxRuns: countField("maxRuns", 10),
  runTimeoutMinutes: durationField("runTimeoutMinutes", MINUTES),
  goalTimeoutMinutes: durationField("goalTimeoutMinutes", MINUTES),
  retryBackoffSeconds: durationField("retryBackoffSeconds", SECONDS),
  userWaitMinutes: durationField("userWaitMinutes", MINUTES),
};

/** Caps walk the stepper's round values; below the smallest is no cap. */
export const GOAL_BUDGET_FIELDS: Record<GoalBudgetKey, GoalNumberField> = {
  maxTotalTokens: {
    scale: {
      ...GOAL_BUDGET_RANGES.maxTotalTokens,
      step: 1000,
      fineStep: 10_000,
      ladder: goalBudgetSteps("maxTotalTokens"),
      nullable: true,
    },
    format: compactCountFormat(),
    inputMode: "numeric",
  },
  maxCostUsd: {
    scale: {
      ...GOAL_BUDGET_RANGES.maxCostUsd,
      step: 1,
      fineStep: 1,
      ladder: goalBudgetSteps("maxCostUsd"),
      nullable: true,
    },
    format: usdFormat(),
    inputMode: "decimal",
  },
};
