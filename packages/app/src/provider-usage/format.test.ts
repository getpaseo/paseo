import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { formatAgo, formatAmount, formatPct, formatResetLabel, formatRunsOutLabel } from "./format";

const NOW = Date.parse("2026-07-19T00:00:00.000Z");

describe("provider usage formatting", () => {
  beforeEach(async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("labels English usage values and timing consistently", () => {
    const twoHoursFromNow = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();

    expect(formatPct(7, "en")).toBe("7%");
    expect(formatAmount(5, "usd", "en")).toBe("$5.00");
    expect(formatResetLabel(twoHoursFromNow)).toBe("resets 2h");
    expect(formatRunsOutLabel(twoHoursFromNow)).toBe("runs out 2h");
  });

  it("formats percentages with locale-specific spacing", () => {
    expect(formatPct(42, "fr")).toBe("42\u00a0%");
  });

  it("uses the active locale for client-owned relative timing copy", async () => {
    await i18n.changeLanguage("ja");
    const twoHoursFromNow = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();
    const threeDaysAgo = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString();

    expect(formatResetLabel(twoHoursFromNow)).toBe("2時間後にリセット");
    expect(formatRunsOutLabel(twoHoursFromNow)).toBe("2時間後に上限に到達");
    expect(formatAgo(threeDaysAgo)).toBe("3日前");
  });

  it("formats relative-time counts with the active locale", async () => {
    await i18n.changeLanguage("fr");
    const days = 1_234;
    const daysFromNow = new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString();
    const daysAgo = new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

    expect(formatResetLabel(daysFromNow)).toBe("se réinitialise dans 1\u202f234 j");
    expect(formatRunsOutLabel(daysFromNow)).toBe("s’épuise dans 1\u202f234 j");
    expect(formatAgo(daysAgo)).toBe("il y a 1\u202f234 j");
  });

  it("selects Arabic plural forms for relative durations", async () => {
    await i18n.changeLanguage("ar");
    const twoHoursFromNow = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();
    const threeHoursFromNow = new Date(NOW + 3 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();

    expect(formatResetLabel(twoHoursFromNow)).toBe("تتم إعادة التعيين خلال ساعتين");
    expect(formatRunsOutLabel(threeHoursFromNow)).toBe("ينفد خلال 3 ساعات");
    expect(formatAgo(twoDaysAgo)).toBe("قبل يومين");
  });

  it("uses locale-aware compact notation for token balances", () => {
    expect(formatAmount(1_234, "tokens", "en")).toBe("1.2K");
    expect(formatAmount(1_234, "tokens", "ar")).toBe("1.2\u00a0ألف");
  });
});
