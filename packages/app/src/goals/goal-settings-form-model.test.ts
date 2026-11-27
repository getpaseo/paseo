import { describe, expect, it } from "vitest";
import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import {
  goalConfigChanges,
  goalSettingsEditValues,
  openGoalSettingsForm,
  validateGoalSettingsEdit,
} from "./goal-settings-form-model";
import { DAEMON_GOAL_SETTINGS } from "./goal-settings";

const CONFIG: GoalConfig = {
  cwd: "/repo",
  leadProvider: "claude",
  defaultProvider: "codex",
  maxParallel: 2,
  maxAttempts: 2,
  autoApprovePlan: false,
  notifyLead: true,
  onPermissionRequest: "wait",
};

function open(config: GoalConfig = CONFIG, overrides: { autoPermissionSupported?: boolean } = {}) {
  return openGoalSettingsForm({
    config,
    budgetSupported: true,
    userWaitSupported: true,
    autoPermissionSupported: overrides.autoPermissionSupported ?? true,
  });
}

describe("goalSettingsEditValues", () => {
  it("fills what the config leaves out with what the daemon runs it with", () => {
    expect(goalSettingsEditValues(CONFIG)).toEqual({
      settings: { ...DAEMON_GOAL_SETTINGS, onPermissionRequest: "wait" },
      budget: { maxTotalTokens: null, maxCostUsd: null },
      testCommand: "",
    });
  });

  it("shows a goal stored without a policy as the fail it runs with", () => {
    const { onPermissionRequest: _omitted, ...stored } = CONFIG;
    expect(goalSettingsEditValues(stored).settings.onPermissionRequest).toBe("fail");
  });

  it("reads limits, budgets and the test command", () => {
    const values = goalSettingsEditValues({
      ...CONFIG,
      maxReworkRounds: 4,
      testCommand: "npm test",
      limits: { maxRuns: 30, runTimeoutMinutes: 15, maxCostUsd: 12.5 },
    });
    expect(values.settings).toMatchObject({
      maxReworkRounds: 4,
      maxRuns: 30,
      runTimeoutMinutes: 15,
    });
    expect(values.budget).toEqual({ maxTotalTokens: null, maxCostUsd: 12.5 });
    expect(values.testCommand).toBe("npm test");
  });
});

describe("goalConfigChanges", () => {
  const baseline = goalSettingsEditValues({
    ...CONFIG,
    testCommand: "npm test",
    limits: { maxTotalTokens: 500_000 },
  });

  it("sends nothing when nothing changed", () => {
    expect(
      goalConfigChanges(baseline, baseline, { budgetSupported: true, userWaitSupported: true }),
    ).toEqual({});
  });

  it("sends only the changed fields, limits nested", () => {
    const values = {
      ...baseline,
      settings: {
        ...baseline.settings,
        maxParallel: 4,
        onPermissionRequest: "auto" as const,
        runTimeoutMinutes: 90,
        notifyLead: false,
      },
    };
    expect(
      goalConfigChanges(baseline, values, { budgetSupported: true, userWaitSupported: true }),
    ).toEqual({
      maxParallel: 4,
      notifyLead: false,
      onPermissionRequest: "auto",
      limits: { runTimeoutMinutes: 90 },
    });
  });

  it("clears a removed budget and test command with null", () => {
    const values = {
      ...baseline,
      budget: { maxTotalTokens: null, maxCostUsd: 5 },
      testCommand: "   ",
    };
    expect(
      goalConfigChanges(baseline, values, { budgetSupported: true, userWaitSupported: true }),
    ).toEqual({
      testCommand: null,
      limits: { maxTotalTokens: null, maxCostUsd: 5 },
    });
  });

  it("trims the test command and ignores whitespace-only edits", () => {
    expect(
      goalConfigChanges(
        baseline,
        { ...baseline, testCommand: " npm test " },
        { budgetSupported: true, userWaitSupported: true },
      ),
    ).toEqual({});
    expect(
      goalConfigChanges(
        baseline,
        { ...baseline, testCommand: " pnpm test " },
        { budgetSupported: true, userWaitSupported: true },
      ),
    ).toEqual({ testCommand: "pnpm test" });
  });

  it("never sends a budget the host cannot enforce", () => {
    const values = { ...baseline, budget: { maxTotalTokens: null, maxCostUsd: 5 } };
    expect(
      goalConfigChanges(baseline, values, { budgetSupported: false, userWaitSupported: true }),
    ).toEqual({});
  });
});

describe("userWaitMinutes", () => {
  const baseline = goalSettingsEditValues(CONFIG);
  const values = { ...baseline, settings: { ...baseline.settings, userWaitMinutes: 60 } };

  it("reads the goal's limit, else the daemon's default", () => {
    expect(baseline.settings.userWaitMinutes).toBe(720);
    expect(
      goalSettingsEditValues({ ...CONFIG, limits: { userWaitMinutes: 90 } }).settings
        .userWaitMinutes,
    ).toBe(90);
  });

  it("is sent as a limit only to a host with goalUserWait", () => {
    expect(
      goalConfigChanges(baseline, values, { budgetSupported: true, userWaitSupported: true }),
    ).toEqual({ limits: { userWaitMinutes: 60 } });
    expect(
      goalConfigChanges(baseline, values, { budgetSupported: true, userWaitSupported: false }),
    ).toEqual({});
  });

  it("flags a value outside the protocol's bounds", () => {
    const issues = validateGoalSettingsEdit({
      ...baseline,
      settings: { ...baseline.settings, userWaitMinutes: 1 },
    });
    expect(issues).toEqual([{ field: "userWaitMinutes", code: "range", min: 5, max: 10080 }]);
  });
});

describe("validateGoalSettingsEdit", () => {
  it("flags numbers the daemon would refuse", () => {
    const values = goalSettingsEditValues(CONFIG);
    expect(validateGoalSettingsEdit(values)).toEqual([]);
    expect(
      validateGoalSettingsEdit({
        ...values,
        settings: { ...values.settings, maxParallel: 9 },
        budget: { maxTotalTokens: 10, maxCostUsd: null },
      }),
    ).toEqual([
      { field: "maxParallel", code: "range", min: 1, max: 8 },
      expect.objectContaining({ field: "maxTotalTokens", code: "range" }),
    ]);
  });
});

describe("openGoalSettingsForm", () => {
  it("starts from the goal's settings with Save off", () => {
    const state = open().getState();
    expect(state.hasChanges).toBe(false);
    expect(state.canSave).toBe(false);
    expect(state.values.settings.onPermissionRequest).toBe("wait");
  });

  it("enables Save once a field differs and off again when it is put back", () => {
    const model = open();
    model.setSetting("maxAttempts", 3);
    expect(model.getState()).toMatchObject({ canSave: true, changes: { maxAttempts: 3 } });
    model.setSetting("maxAttempts", 2);
    expect(model.getState().canSave).toBe(false);
  });

  it("offers auto only on a host that takes it", () => {
    expect(open().getState().policyOptions).toEqual(["wait", "auto", "fail"]);
    expect(open(CONFIG, { autoPermissionSupported: false }).getState().policyOptions).toEqual([
      "wait",
      "fail",
    ]);
  });

  it("keeps Save off while a number is out of range", () => {
    const model = open();
    model.setSetting("maxParallel", 0);
    expect(model.getState()).toMatchObject({ hasChanges: true, canSave: false });
    expect(model.getState().issues.map((issue) => issue.field)).toEqual(["maxParallel"]);
  });

  it("follows a config changed on the host, keeping the fields you changed", () => {
    const model = open();
    model.setSetting("maxParallel", 5);
    model.applyConfig({ ...CONFIG, maxAttempts: 4, maxParallel: 3 });
    const state = model.getState();
    expect(state.values.settings).toMatchObject({ maxParallel: 5, maxAttempts: 4 });
    expect(state.changes).toEqual({ maxParallel: 5 });
  });

  it("has nothing left to save once the host reports the saved settings", () => {
    const model = open();
    model.setSetting("onPermissionRequest", "auto");
    model.setSubmitError("boom");
    model.applyConfig({ ...CONFIG, onPermissionRequest: "auto" });
    expect(model.getState()).toMatchObject({ hasChanges: false, submitError: "boom" });
    model.setSetting("notifyLead", false);
    expect(model.getState().submitError).toBeNull();
  });
});
