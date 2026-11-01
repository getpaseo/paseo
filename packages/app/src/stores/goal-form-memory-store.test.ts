import { describe, expect, it } from "vitest";
import { DAEMON_GOAL_SETTINGS } from "@/goals/goal-settings";
import { GoalFormMemoryPersistedSchema } from "./goal-form-memory-store";

const { userWaitMinutes: _omitted, ...settingsBeforeUserWait } = DAEMON_GOAL_SETTINGS;

function persisted(settings: object) {
  return {
    byServer: {
      host: {
        cwd: "/repo",
        leadProvider: "claude",
        defaultProvider: "codex",
        reviewProvider: null,
        testCommand: null,
        allowedProviders: [],
        settings,
      },
    },
  };
}

describe("GoalFormMemoryPersistedSchema", () => {
  it("reads memory written before the wait limit existed with the daemon's default", () => {
    const parsed = GoalFormMemoryPersistedSchema.parse(persisted(settingsBeforeUserWait));
    expect(parsed.byServer.host?.settings.userWaitMinutes).toBe(
      DAEMON_GOAL_SETTINGS.userWaitMinutes,
    );
  });

  it("keeps a remembered wait limit", () => {
    const parsed = GoalFormMemoryPersistedSchema.parse(
      persisted({ ...settingsBeforeUserWait, userWaitMinutes: 90 }),
    );
    expect(parsed.byServer.host?.settings.userWaitMinutes).toBe(90);
  });
});
