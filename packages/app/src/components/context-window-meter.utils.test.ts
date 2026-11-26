import { describe, expect, it } from "vitest";
import { formatContextPercentage, resolveContextUsage } from "./context-window-meter.utils";

describe("context window meter formatting", () => {
  it("localizes percentages without hiding context overflow", () => {
    expect(formatContextPercentage(125, "en")).toBe("125%");
    expect(formatContextPercentage(42, "fr")).toBe("42\u00a0%");
  });

  it("keeps the fraction of a reported percentage when asked", () => {
    expect(formatContextPercentage(42.5, "en", 2)).toBe("42.5%");
    expect(formatContextPercentage(42, "en", 2)).toBe("42%");
    expect(formatContextPercentage(42.5, "en")).toBe("43%");
  });
});

describe("resolveContextUsage", () => {
  it("derives the share from token counts and rounds it for display", () => {
    expect(
      resolveContextUsage({ maxTokens: 200_000, usedTokens: 56_200, reportedPercentage: null }),
    ).toMatchObject({ percentage: 28, usedTokens: 56_200, maxTokens: 200_000 });
  });

  it("prefers a reported percentage over token counts and keeps its fraction", () => {
    expect(
      resolveContextUsage({ maxTokens: 200_000, usedTokens: 56_200, reportedPercentage: 42.567 }),
    ).toEqual({ percentage: 42.57, ringPercentage: 42.567, usedTokens: null, maxTokens: null });
  });

  it("shows a reported percentage when there are no token counts", () => {
    expect(
      resolveContextUsage({ maxTokens: null, usedTokens: null, reportedPercentage: 0 }),
    ).toMatchObject({ percentage: 0, usedTokens: null, maxTokens: null });
  });

  it("falls back to token counts when the reported percentage is unusable", () => {
    expect(
      resolveContextUsage({ maxTokens: 100, usedTokens: 50, reportedPercentage: Number.NaN }),
    ).toMatchObject({ percentage: 50, usedTokens: 50, maxTokens: 100 });
  });

  it("reports nothing without a usable percentage or token pair", () => {
    expect(resolveContextUsage({ maxTokens: 0, usedTokens: 1, reportedPercentage: null })).toBe(
      null,
    );
    expect(resolveContextUsage({ maxTokens: null, usedTokens: null, reportedPercentage: -1 })).toBe(
      null,
    );
  });
});
