import { describe, expect, it } from "vitest";
import {
  DAEMON_GOAL_SETTINGS,
  GOAL_PRESETS,
  GOAL_SETTING_RANGES,
  goalBudgetToLimits,
  goalPermissionPolicyOptions,
  goalTeam,
  goalSettingSteps,
  goalSettingsToConfig,
  matchGoalSettingsChoice,
  minutesToDuration,
  normalizeGoalSettings,
  secondsToDuration,
  stepGoalBudget,
  stepGoalSetting,
  summarizeGoalSettings,
  supportedGoalSettings,
} from "./goal-settings";

describe("GOAL_SETTING_RANGES", () => {
  it("takes every range from the protocol bounds", () => {
    expect(GOAL_SETTING_RANGES).toEqual({
      maxParallel: { min: 1, max: 8 },
      maxAttempts: { min: 1, max: 5 },
      maxReworkRounds: { min: 0, max: 5 },
      maxTasks: { min: 1, max: 100 },
      maxRuns: { min: 1, max: 500 },
      runTimeoutMinutes: { min: 1, max: 1440 },
      goalTimeoutMinutes: { min: 1, max: 10080 },
      retryBackoffSeconds: { min: 0, max: 3600 },
      userWaitMinutes: { min: 5, max: 10080 },
    });
  });

  it("keeps every preset inside the ranges", () => {
    for (const preset of Object.values(GOAL_PRESETS)) {
      expect(normalizeGoalSettings(preset)).toEqual(preset);
    }
  });
});

describe("matchGoalSettingsChoice", () => {
  it("names the preset the settings equal", () => {
    expect(matchGoalSettingsChoice(GOAL_PRESETS.careful, null)).toBe("careful");
    expect(matchGoalSettingsChoice(DAEMON_GOAL_SETTINGS, null)).toBe("balanced");
  });

  it("prefers a preset over your own, then your own over custom", () => {
    const mine = { ...GOAL_PRESETS.turbo, maxParallel: 6 };
    expect(matchGoalSettingsChoice(GOAL_PRESETS.turbo, GOAL_PRESETS.turbo)).toBe("turbo");
    expect(matchGoalSettingsChoice(mine, mine)).toBe("mine");
    expect(matchGoalSettingsChoice({ ...mine, maxParallel: 7 }, mine)).toBe("custom");
  });
});

describe("stepGoalSetting", () => {
  it("moves counts by one and stops at the range", () => {
    expect(stepGoalSetting("maxParallel", 2, 1)).toBe(3);
    expect(stepGoalSetting("maxParallel", 8, 1)).toBe(8);
    expect(stepGoalSetting("maxReworkRounds", 0, -1)).toBe(0);
  });

  it("walks durations between round values", () => {
    expect(stepGoalSetting("runTimeoutMinutes", 60, 1)).toBe(90);
    expect(stepGoalSetting("runTimeoutMinutes", 60, -1)).toBe(45);
    expect(stepGoalSetting("runTimeoutMinutes", 1440, 1)).toBe(1440);
    expect(stepGoalSetting("goalTimeoutMinutes", 10080, 1)).toBe(10080);
    expect(stepGoalSetting("retryBackoffSeconds", 0, -1)).toBe(0);
  });

  it("snaps an off-ladder value to the next step", () => {
    expect(stepGoalSetting("runTimeoutMinutes", 61, 1)).toBe(90);
    expect(stepGoalSetting("runTimeoutMinutes", 61, -1)).toBe(60);
  });

  it("offers durations only within the range", () => {
    expect(goalSettingSteps("runTimeoutMinutes")?.at(-1)).toBe(1440);
    expect(goalSettingSteps("maxParallel")).toBeNull();
  });
});

describe("durations", () => {
  it("uses the largest whole unit", () => {
    expect(minutesToDuration(90)).toEqual({ unit: "minutes", n: 90 });
    expect(minutesToDuration(120)).toEqual({ unit: "hours", n: 2 });
    expect(minutesToDuration(2880)).toEqual({ unit: "days", n: 2 });
    expect(secondsToDuration(30)).toEqual({ unit: "seconds", n: 30 });
    expect(secondsToDuration(300)).toEqual({ unit: "minutes", n: 5 });
    expect(secondsToDuration(0)).toEqual({ unit: "seconds", n: 0 });
  });
});

describe("goalSettingsToConfig", () => {
  it("sends only the required fields and the policy for the daemon defaults", () => {
    // An older daemon runs a goal without a policy as `fail`, so the default is sent too.
    expect(goalSettingsToConfig(DAEMON_GOAL_SETTINGS)).toEqual({
      maxParallel: 2,
      maxAttempts: 2,
      autoApprovePlan: false,
      notifyLead: true,
      onPermissionRequest: "wait",
    });
    expect(DAEMON_GOAL_SETTINGS.onPermissionRequest).toBe("wait");
  });

  it("sends every changed optional", () => {
    expect(goalSettingsToConfig(GOAL_PRESETS.careful)).toEqual({
      maxParallel: 1,
      maxAttempts: 2,
      autoApprovePlan: false,
      notifyLead: true,
      requireHumanApproval: true,
      maxReworkRounds: 1,
      limits: { maxTasks: 10, maxRuns: 20, runTimeoutMinutes: 30, goalTimeoutMinutes: 240 },
      onPermissionRequest: "wait",
    });
  });
});

describe("goalSettingsToConfig userWaitMinutes", () => {
  const changed = { ...DAEMON_GOAL_SETTINGS, userWaitMinutes: 60 };

  it("sends a changed wait limit only to a host with goalUserWait", () => {
    expect(goalSettingsToConfig(changed, { userWaitSupported: true }).limits).toEqual({
      userWaitMinutes: 60,
    });
    expect(goalSettingsToConfig(changed).limits).toBeUndefined();
    expect(goalSettingsToConfig(changed, { userWaitSupported: false }).limits).toBeUndefined();
  });

  it("leaves the daemon's default out", () => {
    expect(
      goalSettingsToConfig(DAEMON_GOAL_SETTINGS, { userWaitSupported: true }).limits,
    ).toBeUndefined();
  });
});

describe("normalizeGoalSettings", () => {
  it("fills missing fields and clamps numbers into range", () => {
    expect(normalizeGoalSettings({ maxParallel: 50, runTimeoutMinutes: 0.4 })).toEqual({
      ...DAEMON_GOAL_SETTINGS,
      maxParallel: 8,
      runTimeoutMinutes: 1,
    });
  });
});

describe("summarizeGoalSettings", () => {
  it("describes the settings clause by clause", () => {
    expect(
      summarizeGoalSettings(GOAL_PRESETS.careful, { hasTestCommand: true }).map((p) => p.key),
    ).toEqual(["parallel", "runLimit", "deadline", "asksPlan", "asksMerge", "runsTests"]);
    expect(
      summarizeGoalSettings(
        { ...GOAL_PRESETS.careful, onPermissionRequest: "auto" },
        { hasTestCommand: false },
      ).at(-1),
    ).toEqual({ key: "autoPermission" });
    expect(
      summarizeGoalSettings(
        { ...GOAL_PRESETS.careful, onPermissionRequest: "fail" },
        { hasTestCommand: false },
      ).at(-1),
    ).toEqual({ key: "failsPermission" });
    expect(summarizeGoalSettings(GOAL_PRESETS.turbo, { hasTestCommand: false })).toEqual([
      { key: "parallel", n: 4 },
      { key: "runLimit", duration: { unit: "minutes", n: 90 } },
      { key: "deadline", duration: { unit: "hours", n: 12 } },
      { key: "approvesPlan" },
      { key: "mergesReviewed" },
    ]);
  });
});

describe("budget", () => {
  it("steps from no cap up through round caps and back to no cap", () => {
    expect(stepGoalBudget("maxCostUsd", null, 1)).toBe(1);
    expect(stepGoalBudget("maxCostUsd", 1, 1)).toBe(2);
    expect(stepGoalBudget("maxCostUsd", 1, -1)).toBeNull();
    expect(stepGoalBudget("maxCostUsd", null, -1)).toBeNull();
    expect(stepGoalBudget("maxTotalTokens", 100_000_000, 1)).toBe(100_000_000);
    expect(stepGoalBudget("maxTotalTokens", 3_000_000, -1)).toBe(2_000_000);
  });

  it("sends only the caps that are set", () => {
    expect(goalBudgetToLimits({ maxTotalTokens: null, maxCostUsd: null })).toEqual({});
    expect(goalBudgetToLimits({ maxTotalTokens: 500_000, maxCostUsd: 5 })).toEqual({
      maxTotalTokens: 500_000,
      maxCostUsd: 5,
    });
  });
});

describe("goalTeam", () => {
  it("names each role's provider and thinking, workers on the default provider", () => {
    expect(
      goalTeam({
        cwd: "/repo",
        leadProvider: "claude/opus",
        defaultProvider: "codex",
        reviewProvider: "opencode",
        maxParallel: 2,
        maxAttempts: 2,
        autoApprovePlan: false,
        notifyLead: true,
        leadThinking: "high",
        workerThinking: "low",
        verifyThinking: "medium",
      }),
    ).toEqual([
      { role: "lead", provider: "claude/opus", thinking: "high" },
      { role: "worker", provider: "codex", thinking: "low" },
      { role: "reviewer", provider: "opencode", thinking: null },
      { role: "verifier", provider: "opencode", thinking: "medium" },
    ]);
  });
});

describe("permission policy support", () => {
  it("offers auto only on a host that takes it, Ask me first", () => {
    expect(goalPermissionPolicyOptions(true)).toEqual(["wait", "auto", "fail"]);
    expect(goalPermissionPolicyOptions(false)).toEqual(["wait", "fail"]);
  });

  it("turns a remembered auto into wait for a host without it", () => {
    const auto = { ...DAEMON_GOAL_SETTINGS, onPermissionRequest: "auto" as const };
    expect(supportedGoalSettings(auto, false).onPermissionRequest).toBe("wait");
    expect(supportedGoalSettings(auto, true)).toBe(auto);
    const fail = { ...DAEMON_GOAL_SETTINGS, onPermissionRequest: "fail" as const };
    expect(supportedGoalSettings(fail, false)).toBe(fail);
  });
});
