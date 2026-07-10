import { afterEach, describe, it, expect, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  formatDuration,
  formatDurationWithUnits,
  formatMessageTimestamp,
  formatTimeAgo,
} from "./time";

afterEach(async () => {
  vi.useRealTimers();
  await i18n.changeLanguage("en");
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

describe("formatDurationWithUnits", () => {
  const chineseUnits = { second: " 秒", minute: " 分", hour: " 小时" };

  it("renders localized seconds, minutes, and hours", () => {
    expect(formatDurationWithUnits(0, chineseUnits)).toBe("0 秒");
    expect(formatDurationWithUnits(75_230, chineseUnits)).toBe("1 分 15 秒");
    expect(formatDurationWithUnits(3_900_000, chineseUnits)).toBe("1 小时 5 分");
  });
});

describe("formatTimeAgo", () => {
  it("uses the selected app language for relative timestamps", async () => {
    await i18n.changeLanguage("zh-CN");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

    expect(formatTimeAgo(new Date("2026-01-01T00:00:00.000Z"))).toBe("5分钟前");
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

  it("includes full date for older timestamps", () => {
    const now = new Date(2026, 4, 14, 17, 30);
    const date = new Date(2026, 3, 1, 9, 5);
    const formatted = formatMessageTimestamp(date, now);
    expect(formatted).toMatch(/Apr|April/);
    expect(formatted).toMatch(/2026/);
  });
});
