import { describe, it, expect } from "vitest";
import {
  describeCompactTimeAgo,
  describeTimeAgo,
  formatCompactTimeAgo,
  formatCompactTimeAgoAsProse,
  formatCompactTimeUntil,
  formatDuration,
  formatMessageTimestamp,
  formatTimeAgo,
  nextCompactTimeUntilChange,
} from "./time";

describe("formatTimeAgo", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");

  it.each([
    ["2026-07-16T11:59:55.000Z", "just now"],
    ["2026-07-16T11:59:30.000Z", "just now"],
    ["2026-07-16T11:59:00.000Z", "1m ago"],
    ["2026-07-16T11:55:00.000Z", "5m ago"],
    ["2026-07-16T10:00:00.000Z", "2h ago"],
    ["2026-07-13T12:00:00.000Z", "3d ago"],
    ["2026-01-15T12:00:00.000Z", "Jan 15"],
  ])("formats %s as %s", (date, expected) => {
    expect(formatTimeAgo(new Date(date), now)).toBe(expected);
  });
});

describe("formatCompactTimeUntil", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");

  it.each([
    ["2026-07-16T11:58:00.000Z", "<1m"],
    ["2026-07-16T12:00:30.000Z", "<1m"],
    ["2026-07-16T12:01:00.000Z", "<1m"],
    ["2026-07-16T12:01:00.001Z", "2m"],
    ["2026-07-16T12:10:01.000Z", "11m"],
    ["2026-07-16T12:59:30.000Z", "1h"],
    ["2026-07-16T13:00:00.000Z", "1h"],
    ["2026-07-16T15:30:00.000Z", "3h"],
    ["2026-07-17T11:59:30.000Z", "1d"],
    ["2026-07-19T13:00:00.000Z", "3d"],
  ])("counts down to %s as %s", (date, expected) => {
    expect(formatCompactTimeUntil(new Date(date), now)).toBe(expected);
  });
});

describe("nextCompactTimeUntilChange", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");

  it.each([
    // Due at 12:02:00.300: "3m" now, "2m" from 12:00:00.300, "<1m" from 12:01:00.300.
    ["2026-07-16T12:02:00.300Z", "2026-07-16T12:00:00.300Z"],
    ["2026-07-16T12:01:30.000Z", "2026-07-16T12:00:30.000Z"],
    ["2026-07-16T12:10:01.000Z", "2026-07-16T12:00:01.000Z"],
    // "1h" holds until 59 minutes are left.
    ["2026-07-16T13:30:00.000Z", "2026-07-16T12:31:00.000Z"],
    // "3h" holds until 2h59m are left, "1d" until 23h59m.
    ["2026-07-16T15:30:00.000Z", "2026-07-16T12:31:00.000Z"],
    ["2026-07-17T18:00:00.000Z", "2026-07-16T18:01:00.000Z"],
  ])("moves on from a wake at %s at %s", (date, expected) => {
    const next = nextCompactTimeUntilChange(new Date(date), now);
    expect(next?.toISOString()).toBe(expected);
    expect(formatCompactTimeUntil(new Date(date), next!)).not.toBe(
      formatCompactTimeUntil(new Date(date), new Date(next!.getTime() - 1)),
    );
  });

  it.each(["2026-07-16T12:01:00.000Z", "2026-07-16T12:00:00.000Z", "2026-07-16T11:00:00.000Z"])(
    "stops once a wake at %s reads <1m",
    (date) => {
      expect(nextCompactTimeUntilChange(new Date(date), now)).toBeNull();
    },
  );
});

describe("describeTimeAgo", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");

  it.each([
    ["2026-07-16T11:59:30.000Z", "just now", "minute"],
    ["2026-07-16T11:55:00.000Z", "5m ago", "minute"],
    ["2026-07-16T10:00:00.000Z", "2h ago", "hour"],
    ["2026-07-13T12:00:00.000Z", "3d ago", "day"],
    ["2026-01-15T12:00:00.000Z", "Jan 15", "static"],
  ] as const)("formats %s as %s at %s resolution", (date, label, resolution) => {
    expect(describeTimeAgo(new Date(date), now)).toEqual({ label, resolution });
  });
});

describe("describeCompactTimeAgo", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");

  it.each([
    ["2026-07-16T11:59:59.000Z", "now", "minute"],
    ["2026-07-16T11:59:30.000Z", "now", "minute"],
    ["2026-07-16T11:59:00.000Z", "1m", "minute"],
    ["2026-07-16T11:55:00.000Z", "5m", "minute"],
    ["2026-07-16T11:00:00.000Z", "1h", "hour"],
    ["2026-07-16T10:00:00.000Z", "2h", "hour"],
    ["2026-07-15T12:00:00.000Z", "1d", "day"],
    ["2026-07-13T12:00:00.000Z", "3d", "day"],
    ["2026-07-10T12:00:00.000Z", "6d", "day"],
    ["2026-07-09T12:00:00.000Z", "Jul 9", "static"],
    ["2026-01-15T12:00:00.000Z", "Jan 15", "static"],
  ] as const)("formats %s as %s at %s resolution", (date, label, resolution) => {
    expect(describeCompactTimeAgo(new Date(date), now)).toEqual({ label, resolution });
  });

  it("never shows a sub-minute count", () => {
    // A seconds label is only true for the second it rendered. Everything under a minute is
    // "now", which stays true and lets the row sit still.
    for (let seconds = 0; seconds < 60; seconds += 1) {
      const date = new Date(now.getTime() - seconds * 1000);
      expect(describeCompactTimeAgo(date, now).label).toBe("now");
    }
  });

  it("switches to an absolute date exactly at seven days", () => {
    const almost = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000 - 1));
    const exactly = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(describeCompactTimeAgo(almost, now).resolution).toBe("day");
    expect(describeCompactTimeAgo(exactly, now).resolution).toBe("static");
  });

  it("keeps formatCompactTimeAgo as the label alone", () => {
    const date = new Date("2026-07-16T10:00:00.000Z");
    expect(formatCompactTimeAgo(date, now)).toBe(describeCompactTimeAgo(date, now).label);
  });
});

describe("formatCompactTimeAgoAsProse", () => {
  it("puts elapsed labels back into prose and leaves dates alone", () => {
    expect(formatCompactTimeAgoAsProse("now")).toBe("just now");
    expect(formatCompactTimeAgoAsProse("3m")).toBe("3m ago");
    expect(formatCompactTimeAgoAsProse("2h")).toBe("2h ago");
    expect(formatCompactTimeAgoAsProse("Jan 15")).toBe("Jan 15");
  });
});

describe("formatDuration", () => {
  it("renders sub-minute durations as whole seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(5_600)).toBe("5s");
    expect(formatDuration(9_900)).toBe("9s");
    expect(formatDuration(10_400)).toBe("10s");
    expect(formatDuration(12_340)).toBe("12s");
    expect(formatDuration(47_000)).toBe("47s");
  });

  it("renders minutes and remainder seconds without decimals", () => {
    expect(formatDuration(75_230)).toBe("1m 15s");
    expect(formatDuration(132_000)).toBe("2m 12s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("renders hours and remainder minutes without decimals", () => {
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    expect(formatDuration(3_600_000)).toBe("1h");
  });

  it("guards against negative and NaN", () => {
    expect(formatDuration(-1)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});

describe("formatMessageTimestamp", () => {
  it("shows only time for same-day timestamps", () => {
    const now = new Date(2026, 4, 14, 17, 30);
    const date = new Date(2026, 4, 14, 12, 23);
    const formatted = formatMessageTimestamp(date, now);
    expect(formatted).toMatch(/12:23/);
    expect(formatted).not.toMatch(/Thursday|Wednesday/);
  });

  it("includes weekday for timestamps within the last 6 days", () => {
    // 2026-05-14 is a Thursday. 2026-05-11 is a Monday.
    const now = new Date(2026, 4, 14, 17, 30);
    const date = new Date(2026, 4, 11, 22, 12);
    const formatted = formatMessageTimestamp(date, now);
    expect(formatted).toMatch(/Monday/);
    expect(formatted).toMatch(/10:12 PM|22:12/);
  });

  it("shows the full date for last week's same weekday, even under seven days ago", () => {
    // 2026-09-18 is a Friday. The reply is 6 days 23h45m old and lands on today's weekday,
    // so a weekday label would read as today.
    const now = new Date(2026, 8, 25, 11, 47);
    const date = new Date(2026, 8, 18, 12, 2);
    const formatted = formatMessageTimestamp(date, now);
    expect(formatted).toMatch(/Sep|September/);
    expect(formatted).toMatch(/18/);
    expect(formatted).not.toMatch(/Friday/);
  });

  it("includes full date for older timestamps", () => {
    const now = new Date(2026, 4, 14, 17, 30);
    const date = new Date(2026, 3, 1, 9, 5);
    const formatted = formatMessageTimestamp(date, now);
    expect(formatted).toMatch(/Apr|April/);
    expect(formatted).toMatch(/2026/);
  });
});
