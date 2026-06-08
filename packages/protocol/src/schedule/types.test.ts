import { describe, expect, it } from "vitest";

import { ScheduleCadenceSchema, ScheduleRunSchema, ScheduleTargetSchema } from "./types.js";

describe("schedule schemas", () => {
  it("accepts existing UTC cron cadence without a time zone", () => {
    expect(ScheduleCadenceSchema.parse({ type: "cron", expression: "0 9 * * *" })).toEqual({
      type: "cron",
      expression: "0 9 * * *",
    });
  });

  it("accepts timezone-aware cron cadence", () => {
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

  it("accepts legacy uuid-shaped agent ids with version 0", () => {
    const legacyAgentId = "00000000-0000-0000-0000-000000000001";

    expect(ScheduleTargetSchema.parse({ type: "agent", agentId: legacyAgentId })).toEqual({
      type: "agent",
      agentId: legacyAgentId,
    });
    expect(
      ScheduleRunSchema.parse({
        id: "run-1",
        scheduledFor: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
        status: "succeeded",
        agentId: legacyAgentId,
        output: null,
        error: null,
      }).agentId,
    ).toBe(legacyAgentId);
  });
});
