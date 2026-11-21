import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  formatDisplayPct,
  formatAgo,
  formatAmount,
  formatPct,
  formatProviderUsageLabel,
  formatResetLabel,
  formatResetTime,
  formatRunsOutLabel,
} from "./format";

const NOW = Date.parse("2026-07-19T00:00:00.000Z");

describe("formatAmount", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
  });
  it("groups thousands in the app's language", () => {
    expect(formatAmount(12345, "credits", "en")).toBe("12,345");
    expect(formatAmount(12345, "requests", "en")).toBe("12,345");
    expect(formatAmount(12345, "credits", "fr").replace(/\s/g, " ")).toBe("12 345");
  });

  it("formats dollars as the language writes currency", () => {
    expect(formatAmount(1234.5, "usd", "en")).toBe("$1,234.50");
    expect(formatAmount(1234.5, "usd", "fr").replace(/\s/g, " ")).toBe("1 234,50 $US");
  });

  it("localizes usage timing without patching the global clock", async () => {
    const twoHoursFromNow = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();
    const threeDaysAgo = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString();

    expect(formatPct(7, "en")).toBe("7%");
    expect(formatResetLabel(twoHoursFromNow, false, NOW)).toBe("resets in 2h");

    await i18n.changeLanguage("ja");
    expect(formatResetLabel(twoHoursFromNow, false, NOW)).toBe("2時間後にリセット");
    expect(formatAgo(threeDaysAgo, NOW)).toBe("3日前");
  });

  it("formats percentages with locale-specific spacing", () => {
    expect(formatPct(42, "fr")).toBe("42\u00a0%");
  });

  it("formats relative-time counts with the active locale", async () => {
    await i18n.changeLanguage("fr");
    const days = 1_234;
    const daysFromNow = new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString();
    const daysAgo = new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

    expect(formatResetLabel(daysFromNow, false, NOW)).toBe("se réinitialise dans 1\u202f234 j");
    expect(formatAgo(daysAgo, NOW)).toBe("il y a 1\u202f234 j");
  });

  it("selects Arabic plural forms for relative durations", async () => {
    await i18n.changeLanguage("ar");
    const twoHoursFromNow = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();

    expect(formatResetLabel(twoHoursFromNow, false, NOW)).toBe("تتم إعادة التعيين خلال ساعتين");
    expect(formatAgo(twoDaysAgo, NOW)).toBe("قبل يومين");
  });

  it("uses locale-aware compact notation for token balances", () => {
    expect(formatAmount(1_234, "tokens", "en")).toBe("1.2K");
    expect(formatAmount(1_234, "tokens", "ar")).toBe("1.2\u00a0ألف");
  });

  it("localizes known provider-usage labels and preserves provider-specific labels", async () => {
    await i18n.changeLanguage("ko");

    expect(formatProviderUsageLabel("session", "Session")).toBe("세션");
    expect(formatProviderUsageLabel("five_hour", "Session")).toBe("세션");
    expect(formatProviderUsageLabel("five_hour", "5-hour limit")).toBe("5-hour limit");
    expect(formatProviderUsageLabel("monthly", "Monthly")).toBe("월간");
    expect(formatProviderUsageLabel("code_review:weekly", "Code review · Weekly")).toBe(
      "코드 검토 · 주간",
    );
    expect(formatProviderUsageLabel("code_review:five_hour", "Code review · 5-hour")).toBe(
      "코드 검토 · 5-hour",
    );
    expect(formatProviderUsageLabel("credits", "Credits")).toBe("크레딧");
    expect(formatProviderUsageLabel("custom_limit", "Custom limit")).toBe("Custom limit");
  });
});

describe("reset countdown", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const countdown = (ms: number) => formatResetLabel(new Date(NOW + ms).toISOString(), false, NOW);

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("keeps counting down inside a day instead of sitting on the rounded-down day", () => {
    expect(countdown(2 * DAY + 23 * HOUR + 10 * MINUTE)).toBe("resets in 2d 23h");
    expect(countdown(2 * DAY + 22 * HOUR + 10 * MINUTE)).toBe("resets in 2d 22h");
  });

  it("says two units, dropping a unit that is zero", () => {
    expect(countdown(4 * HOUR + 59 * MINUTE)).toBe("resets in 4h 59m");
    expect(countdown(HOUR)).toBe("resets in 1h");
    expect(countdown(37 * MINUTE)).toBe("resets in 37m");
    expect(countdown(59 * 1000)).toBe("resets in 0m");
  });

  it("shows a single day as 24 hours in the reset countdown", () => {
    expect(countdown(DAY)).toBe("resets in 24h");
    expect(countdown(DAY + 30 * MINUTE)).toBe("resets in 24h");
    expect(countdown(DAY + HOUR)).toBe("resets in 1d 1h");
    expect(countdown(2 * DAY)).toBe("resets in 2d");
  });
});

describe("exact quota times", () => {
  // Local-time dates, so the thresholds hold in any timezone the tests run in.
  const now = new Date(2026, 9, 29, 12, 0).getTime();
  const at = (...args: [number, number, number, number, number]) =>
    formatResetTime(new Date(...args).toISOString(), now)?.replace(/\s/g, " ");

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("shows only the time for the same local day", () => {
    expect(at(2026, 9, 29, 15, 0)).toMatch(/^(3:00 PM|15:00)$/);
  });

  it("shows the weekday for tomorrow even when it is less than 24 hours away", () => {
    expect(at(2026, 9, 30, 11, 59)).toMatch(/^Fri (11:59 AM|11:59)$/);
    expect(at(2026, 10, 4, 15, 0)).toMatch(/^Wed (3:00 PM|15:00)$/);
  });

  it("includes the date on the same weekday next week even when fewer than 7 days elapse", () => {
    expect(at(2026, 10, 5, 10, 0)).toMatch(/^Thu, Nov 5, (10:00 AM|10:00)$/);
  });

  it("includes the weekday and date seven or more calendar days out", () => {
    expect(at(2026, 10, 5, 12, 0)).toMatch(/^Thu, Nov 5, (12:00 PM|12:00)$/);
    expect(at(2026, 10, 6, 15, 0)).toMatch(/^Fri, Nov 6, (3:00 PM|15:00)$/);
  });

  it("counts calendar days across the spring daylight-saving transition", () => {
    vi.stubEnv("TZ", "America/New_York");
    try {
      const before = new Date(2026, 2, 7, 12);
      const after = new Date(2026, 2, 14, 12);
      expect(after.getTime() - before.getTime()).toBe(167 * 3_600_000);
      expect(formatResetTime(after.toISOString(), before.getTime())).toMatch(/^Sat, Mar 14, /);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("shows the exhaustion clock time with the same weekday and date rules as reset time", () => {
    const runsOut = (...args: [number, number, number, number, number]) =>
      formatRunsOutLabel(new Date(...args).toISOString(), now)?.replace(/\s/g, " ");

    expect(runsOut(2026, 9, 29, 15, 0)).toMatch(/^runs out (3:00 PM|15:00)$/);
    expect(runsOut(2026, 9, 30, 9, 32)).toMatch(/^runs out Fri (9:32 AM|09:32|9:32)$/);
    expect(runsOut(2026, 10, 5, 15, 30)).toMatch(/^runs out Thu, Nov 5, (3:30 PM|15:30)$/);
  });

  it("uses the app language for the exhaustion label and weekday", async () => {
    await i18n.changeLanguage("ja");
    const time = new Date(2026, 9, 30, 15, 30).toISOString();
    expect(formatRunsOutLabel(time, now)?.replace(/\s/g, " ")).toMatch(
      /^金 (?:3:30 PM|15:30)に上限に到達$/,
    );
  });

  it("names the weekday in the app language", async () => {
    await i18n.changeLanguage("fr");
    expect(at(2026, 9, 31, 15, 0)).toMatch(/^sam\.? /);
  });

  it("says nothing for a time that has passed", () => {
    expect(formatResetTime(new Date(now - 1).toISOString(), now)).toBeNull();
    expect(formatResetTime(null, now)).toBeNull();
  });
});

it("retained reset times that have passed do not claim the quota is resetting", () => {
  const past = "2000-01-01T00:00:00.000Z";
  expect(formatResetLabel(past, true)).toBe("Reset time passed");
  expect(formatResetLabel(past)).toBe("resetting now");
  expect(formatResetLabel(null, true)).toBeNull();
});

it("says that a usage window percentage is consumed", () => {
  expect(formatDisplayPct(70, "used")).toBe("70% used");
  expect(formatDisplayPct(30, "remaining")).toBe("30% left");
});
it("translates the usage refresh control into Japanese", async () => {
  try {
    await i18n.changeLanguage("ja");
    expect(i18n.t("providerUsage.refresh")).toBe("更新");
  } finally {
    await i18n.changeLanguage("en");
  }
});

it("translates the neighboring usage percentage settings", async () => {
  try {
    await i18n.changeLanguage("ja");
    expect(i18n.t("providerUsage.displayUsed")).toBe("使用済み");
    expect(i18n.t("providerUsage.displayRemaining")).toBe("残り");
  } finally {
    await i18n.changeLanguage("en");
  }
});

it("preserves provider-defined labels even when their IDs match a standard period", () => {
  expect(formatProviderUsageLabel("monthly", "Extra allotment")).toBe("Extra allotment");
  expect(formatProviderUsageLabel("code_review:weekly", "Custom review allowance")).toBe(
    "Custom review allowance",
  );
});
