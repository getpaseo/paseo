import { describe, expect, it } from "vitest";
import { stepScrubValue } from "@/utils/scrub-number";
import { GOAL_BUDGET_FIELDS, GOAL_SETTING_FIELDS } from "./goal-number-fields";
import {
  DAEMON_GOAL_SETTINGS,
  GOAL_PRESETS,
  GOAL_SETTING_RANGES,
  goalBudgetSteps,
  goalSettingSteps,
  stepGoalBudget,
  stepGoalSetting,
  type GoalBudgetKey,
  type GoalNumberSetting,
} from "./goal-settings";

const SETTINGS = Object.keys(GOAL_SETTING_FIELDS) as GoalNumberSetting[];
const BUDGETS = Object.keys(GOAL_BUDGET_FIELDS) as GoalBudgetKey[];

describe("goal number fields", () => {
  it("offer the decimal pad only where a fraction is a valid value", () => {
    for (const setting of SETTINGS) {
      expect(GOAL_SETTING_FIELDS[setting].inputMode).toBe("numeric");
    }
    expect(GOAL_BUDGET_FIELDS.maxTotalTokens.inputMode).toBe("numeric");
    expect(GOAL_BUDGET_FIELDS.maxCostUsd.inputMode).toBe("decimal");
    expect(GOAL_BUDGET_FIELDS.maxCostUsd.format.parse("0.5")).toBe(0.5);
  });

  it("cover every number setting with its range", () => {
    expect(SETTINGS.sort()).toEqual((Object.keys(GOAL_SETTING_RANGES) as string[]).sort());
    for (const setting of SETTINGS) {
      expect(GOAL_SETTING_FIELDS[setting].scale.min).toBe(GOAL_SETTING_RANGES[setting].min);
      expect(GOAL_SETTING_FIELDS[setting].scale.max).toBe(GOAL_SETTING_RANGES[setting].max);
    }
  });

  it("step durations exactly like the stepper", () => {
    for (const setting of SETTINGS) {
      const ladder = goalSettingSteps(setting);
      if (!ladder) {
        continue;
      }
      const { scale } = GOAL_SETTING_FIELDS[setting];
      for (const value of [...ladder, 7, scale.max]) {
        for (const direction of [1, -1] as const) {
          expect(stepScrubValue(scale, value, direction)).toBe(
            stepGoalSetting(setting, value, direction),
          );
        }
      }
    }
  });

  it("step budgets exactly like the stepper, through no cap", () => {
    for (const key of BUDGETS) {
      const { scale } = GOAL_BUDGET_FIELDS[key];
      for (const value of [null, ...goalBudgetSteps(key), 3]) {
        for (const direction of [1, -1] as const) {
          expect(stepScrubValue(scale, value, direction)).toBe(
            stepGoalBudget(key, value, direction),
          );
        }
      }
    }
  });

  it("show every preset and default value as text that reads back the same", () => {
    const presets = [DAEMON_GOAL_SETTINGS, ...Object.values(GOAL_PRESETS)];
    for (const settings of presets) {
      for (const setting of SETTINGS) {
        const { format } = GOAL_SETTING_FIELDS[setting];
        expect(format.parse(format.format(settings[setting]))).toBe(settings[setting]);
      }
    }
    for (const key of BUDGETS) {
      const { format } = GOAL_BUDGET_FIELDS[key];
      for (const value of goalBudgetSteps(key)) {
        expect(format.parse(format.format(value))).toBe(value);
      }
    }
  });
});
