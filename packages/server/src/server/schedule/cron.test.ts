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

  test("matches either restricted day field", () => {
    const next = computeNextRunAt(
      { type: "cron", expression: "0 9 1 * 1" },
      new Date("2026-10-17T00:00:00.000Z"),
    );

    expect(next.toISOString()).toBe("2026-10-19T09:00:00.000Z");
  });

  test.each([
    ["0 9 1 * 1", "2026-10-30T10:00:00.000Z", "2026-11-01T09:00:00.000Z"],
    ["0 9 1 * *", "2026-10-17T00:00:00.000Z", "2026-11-01T09:00:00.000Z"],
    ["0 9 * * 1", "2026-10-17T00:00:00.000Z", "2026-10-19T09:00:00.000Z"],
    ["0 9 */2 * 1", "2026-10-19T09:00:00.000Z", "2026-11-09T09:00:00.000Z"],
    ["0 9 1-31 * 1", "2026-10-17T00:00:00.000Z", "2026-10-17T09:00:00.000Z"],
    ["0 9 1,15 * 5", "2026-10-17T00:00:00.000Z", "2026-10-23T09:00:00.000Z"],
  ])("honors day-field semantics for %s", (expression, after, expected) => {
    const next = computeNextRunAt({ type: "cron", expression }, new Date(after));

    expect(next.toISOString()).toBe(expected);
  });

  test("matches either restricted day field in the schedule's time zone", () => {
    const next = computeNextRunAt(
      { type: "cron", expression: "0 9 1 * 1", timezone: "America/New_York" },
      new Date("2026-10-17T00:00:00.000Z"),
    );

    expect(next.toISOString()).toBe("2026-10-19T13:00:00.000Z");
  });

  test("computes timezone cron matches at the requested wall-clock time", () => {
    const winter = computeNextRunAt(
      { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York" },
      new Date("2026-01-05T13:59:30.000Z"),
    );
    const summer = computeNextRunAt(
      { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York" },
      new Date("2026-07-06T12:59:30.000Z"),
    );

    expect(winter.toISOString()).toBe("2026-01-05T14:00:00.000Z");
    expect(summer.toISOString()).toBe("2026-07-06T13:00:00.000Z");
  });

  test("keeps repeated fall-back wall-clock matches distinct", () => {
    const first = computeNextRunAt(
      { type: "cron", expression: "30 1 1 11 *", timezone: "America/New_York" },
      new Date("2026-11-01T05:29:30.000Z"),
    );
    const second = computeNextRunAt(
      { type: "cron", expression: "30 1 1 11 *", timezone: "America/New_York" },
      first,
    );

    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(second.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });

  test("rejects invalid cron expressions", () => {
    expect(() => validateScheduleCadence({ type: "cron", expression: "not-a-valid-cron" })).toThrow(
      "Cron expressions must have 5 fields",
    );
  });

  test("rejects step fields with extra slash tokens", () => {
    expect(() => validateScheduleCadence({ type: "cron", expression: "*/5/2 * * * *" })).toThrow(
      "Invalid cron minute step",
    );
  });

  test("rejects invalid cron time zones", () => {
    expect(() =>
      validateScheduleCadence({
        type: "cron",
        expression: "0 9 * * *",
        timezone: "Not/AZone",
      }),
    ).toThrow("Invalid cron time zone: Not/AZone");
  });
});
