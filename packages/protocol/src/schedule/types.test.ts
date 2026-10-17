import { describe, expect, test } from "vitest";

import { ScheduleCadenceSchema, ScheduleTargetSchema } from "./types.js";

describe("ScheduleCadenceSchema", () => {
  test("accepts existing UTC cron cadence without a time zone", () => {
    expect(ScheduleCadenceSchema.parse({ type: "cron", expression: "0 9 * * *" })).toEqual({
      type: "cron",
      expression: "0 9 * * *",
    });
  });

  test("accepts timezone-aware cron cadence", () => {
    expect(
      ScheduleCadenceSchema.parse({
        type: "cron",
        expression: "0 9 * * *",
        timezone: "America/New_York",
      }),
    ).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "America/New_York",
    });
  });
});

describe("ScheduleTargetSchema", () => {
  test("keeps the workspace a new-agent schedule runs in", () => {
    const target = {
      type: "new-agent",
      config: { provider: "claude", cwd: "/tmp/project", workspaceId: "wks_weekly" },
    };

    expect(ScheduleTargetSchema.parse(target)).toEqual(target);
  });

  test("parses stored new-agent schedules that predate the workspace field", () => {
    const target = { type: "new-agent", config: { provider: "claude", cwd: "/tmp/project" } };

    expect(ScheduleTargetSchema.parse(target)).toEqual(target);
  });

  test("still requires a cwd on stored new-agent schedules", () => {
    expect(() =>
      ScheduleTargetSchema.parse({
        type: "new-agent",
        config: { provider: "claude", workspaceId: "wks_weekly" },
      }),
    ).toThrow();
  });
});
