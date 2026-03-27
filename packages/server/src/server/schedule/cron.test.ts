import { describe, expect, test } from "vitest";
import { computeNextRunAt, validateScheduleCadence } from "./cron.js";

describe("schedule cron cadence", () => {
  test("computes the next every cadence from the provided timestamp", () => {
    const next = computeNextRunAt(
      { type: "every", everyMs: 5 * 60_000 },
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(next.toISOString()).toBe("2026-01-01T00:05:00.000Z");
  });

  test("computes the next cron minute match in UTC", () => {
    const next = computeNextRunAt(
      { type: "cron", expression: "15 9 * * 1-5" },
      new Date("2026-01-05T09:14:30.000Z"),
    );

    expect(next.toISOString()).toBe("2026-01-05T09:15:00.000Z");
  });

  test("rejects invalid cron expressions", () => {
    expect(() =>
      validateScheduleCadence({ type: "cron", expression: "not-a-valid-cron" }),
    ).toThrow("Cron expressions must have 5 fields");
  });
});
