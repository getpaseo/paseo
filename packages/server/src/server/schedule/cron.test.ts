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

  test("finds a leap day beyond the following year", () => {
    const next = computeNextRunAt(
      { type: "cron", expression: "0 0 29 2 *" },
      new Date("2026-10-17T00:00:00.000Z"),
    );

    expect(next.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  test.each([
    ["2028-02-29T00:00:00.000Z", "2032-02-29T00:00:00.000Z"],
    ["2096-02-29T00:00:00.000Z", "2104-02-29T00:00:00.000Z"],
  ])("finds the next leap day after %s", (after, expected) => {
    const next = computeNextRunAt({ type: "cron", expression: "0 0 29 2 *" }, new Date(after));

    expect(next.toISOString()).toBe(expected);
  });

  test.each([
    ["America/New_York", "2028-02-29T05:00:00.000Z"],
    ["Pacific/Kiritimati", "2028-02-28T10:00:00.000Z"],
  ])("finds leap-day midnight in %s", (timezone, expected) => {
    const next = computeNextRunAt(
      { type: "cron", expression: "0 0 29 2 *", timezone },
      new Date("2026-10-17T00:00:00.000Z"),
    );

    expect(next.toISOString()).toBe(expected);
  });

  test("skips a missing annual wall-clock time during daylight saving time", () => {
    const next = computeNextRunAt(
      { type: "cron", expression: "30 2 14 3 *", timezone: "America/New_York" },
      new Date("2026-03-14T06:30:00.000Z"),
    );

    expect(next.toISOString()).toBe("2028-03-14T06:30:00.000Z");
  });

  test.each([
    ["Pacific/Kiritimati", "2026-12-30T23:59:00.000Z", "2026-12-31T10:00:00.000Z"],
    ["Etc/GMT+12", "2026-12-31T23:59:00.000Z", "2027-01-01T12:00:00.000Z"],
  ])("keeps the first local minute when skipping months in %s", (timezone, after, expected) => {
    const next = computeNextRunAt(
      { type: "cron", expression: "0 0 1 1 *", timezone },
      new Date(after),
    );

    expect(next.toISOString()).toBe(expected);
  });

  test("rejects a calendar date that never occurs", () => {
    expect(() =>
      computeNextRunAt(
        { type: "cron", expression: "0 0 30 2 *" },
        new Date("2026-10-17T00:00:00.000Z"),
      ),
    ).toThrow("Unable to compute next run time for cron expression: 0 0 30 2 *");
  });

  test.each(["*", "*/2"])("rejects impossible month lists with weekday %s", (weekday) => {
    const expression = `0 0 31 2,4,6,9,11 ${weekday}`;

    expect(() =>
      computeNextRunAt(
        { type: "cron", expression, timezone: "America/New_York" },
        new Date("2026-10-17T00:00:00.000Z"),
      ),
    ).toThrow(`Unable to compute next run time for cron expression: ${expression}`);
  });

  test("keeps month lists that include a valid selected date", () => {
    const next = computeNextRunAt(
      { type: "cron", expression: "0 0 31 2,4,6,9,11,12 *", timezone: "America/New_York" },
      new Date("2026-10-17T00:00:00.000Z"),
    );

    expect(next.toISOString()).toBe("2026-12-31T05:00:00.000Z");
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
