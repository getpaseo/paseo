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

  it("uses the active locale for client-owned relative timing copy", async () => {
    await i18n.changeLanguage("ja");
    const twoHoursFromNow = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();
    const threeDaysAgo = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString();

    expect(formatResetLabel(twoHoursFromNow)).toBe("2時間後にリセット");
    expect(formatRunsOutLabel(twoHoursFromNow)).toBe("2時間後に上限に到達");
    expect(formatAgo(threeDaysAgo)).toBe("3日前");
  });
});
