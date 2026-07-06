import { describe, expect, it } from "vitest";
import { nextCronCadence } from "./schedule-cadence-policy";

describe("nextCronCadence", () => {
  it("preserves an existing cron cadence timezone when editing the expression", () => {
    expect(
      nextCronCadence(
        {
          type: "cron",
          expression: "0 9 * * *",
          timezone: "America/New_York",
        },
        "30 9 * * *",
        "America/Los_Angeles",
      ),
    ).toEqual({
      type: "cron",
      expression: "30 9 * * *",
      timezone: "America/New_York",
    });
  });

  it("emits UTC for legacy cron cadences without a timezone", () => {
    expect(
      nextCronCadence(
        {
          type: "cron",
          expression: "0 9 * * *",
        },
        "30 9 * * *",
        "America/Los_Angeles",
      ),
    ).toEqual({
      type: "cron",
      expression: "30 9 * * *",
      timezone: "UTC",
    });
  });

  it("uses the device timezone when switching from interval to cron", () => {
    expect(
      nextCronCadence(
        {
          type: "every",
          everyMs: 60 * 60_000,
        },
        "0 9 * * *",
        "America/Los_Angeles",
      ),
    ).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "America/Los_Angeles",
    });
  });

  it("lets callers preserve a remembered cron timezone when toggling back from interval", () => {
    expect(
      nextCronCadence(
        {
          type: "every",
          everyMs: 60 * 60_000,
        },
        "0 9 * * *",
        "America/New_York",
      ),
    ).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "America/New_York",
    });
  });
});
