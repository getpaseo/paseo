import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { formatAgo, formatAmount, formatPct, formatResetLabel, formatRunsOutLabel } from "./format";

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
    expect(formatResetLabel(twoHoursFromNow, NOW)).toBe("resets in 2h");
    expect(formatRunsOutLabel(twoHoursFromNow, NOW)).toBe("runs out in 2h");

    await i18n.changeLanguage("ja");
    expect(formatResetLabel(twoHoursFromNow, NOW)).toBe("2時間後にリセット");
    expect(formatRunsOutLabel(twoHoursFromNow, NOW)).toBe("2時間後に上限に到達");
    expect(formatAgo(threeDaysAgo, NOW)).toBe("3日前");
  });

  it("formats percentages with locale-specific spacing", () => {
    expect(formatPct(42, "fr")).toBe("42\u00a0%");
  });
});
