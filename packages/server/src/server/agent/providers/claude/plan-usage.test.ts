import { describe, expect, it } from "vitest";
import { claudeModelFamily, planWindowsFromRateLimitInfo } from "./plan-usage.js";

describe("planWindowsFromRateLimitInfo", () => {
  it("maps every unified window, labelling the per-model bucket after the running model", () => {
    const windows = planWindowsFromRateLimitInfo(
      {
        status: "allowed_warning",
        rateLimitType: "seven_day_overage_included",
        utilization: 0.93,
        resetsAt: 1788199200,
        unifiedWindows: {
          five_hour: { utilization: 0, resetsAt: 1788143400 },
          seven_day: { utilization: 0.46, resetsAt: 1788199200 },
          seven_day_overage_included: { utilization: 0.93, resetsAt: 1788199200 },
        },
      },
      "claude-fable-5",
    );

    expect(windows).toEqual([
      {
        id: "five_hour",
        label: "Session",
        usedPct: 0,
        resetsAt: "2026-08-31T02:30:00.000Z",
        tone: "ok",
      },
      {
        id: "seven_day",
        label: "Weekly",
        usedPct: 46,
        resetsAt: "2026-08-31T18:00:00.000Z",
        tone: "ok",
      },
      {
        id: "seven_day_overage_included",
        label: "Weekly · Fable",
        usedPct: 93,
        resetsAt: "2026-08-31T18:00:00.000Z",
        tone: "danger",
      },
    ]);
  });

  it("falls back to the single representative claim when no unified map is sent", () => {
    expect(
      planWindowsFromRateLimitInfo(
        { status: "allowed", rateLimitType: "five_hour", utilization: 0.12, resetsAt: 1788143400 },
        "claude-sonnet-4-6",
      ),
    ).toEqual([
      {
        id: "five_hour",
        label: "Session",
        usedPct: 12,
        resetsAt: "2026-08-31T02:30:00.000Z",
        tone: "ok",
      },
    ]);
  });

  it("orders unknown claims after the known ones and skips overage and empty entries", () => {
    const windows = planWindowsFromRateLimitInfo(
      {
        unifiedWindows: {
          overage: { utilization: 0.5 },
          some_new_claim: { utilization: 0.2 },
          seven_day: { utilization: 0.1 },
          five_hour: null,
          seven_day_sonnet: { utilization: "bad" },
        },
      },
      null,
    );

    expect(windows?.map((window) => [window.id, window.label, window.usedPct])).toEqual([
      ["seven_day", "Weekly", 10],
      ["some_new_claim", "Some new claim", 20],
    ]);
  });

  it("returns null for payloads that describe no window", () => {
    expect(planWindowsFromRateLimitInfo({ status: "allowed" }, "claude-fable-5")).toBeNull();
    expect(planWindowsFromRateLimitInfo("nonsense", null)).toBeNull();
    expect(planWindowsFromRateLimitInfo({ unifiedWindows: {} }, null)).toBeNull();
  });
});

describe("claudeModelFamily", () => {
  it("names the family from a model id", () => {
    expect(claudeModelFamily("claude-fable-5")).toBe("Fable");
    expect(claudeModelFamily("claude-opus-4-6")).toBe("Opus");
    expect(claudeModelFamily("claude-haiku-4-5-20251001")).toBe("Haiku");
    expect(claudeModelFamily("gpt-5")).toBeNull();
    expect(claudeModelFamily(undefined)).toBeNull();
  });
});
