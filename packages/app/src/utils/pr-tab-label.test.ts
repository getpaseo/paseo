import { describe, expect, it } from "vitest";
import type { PrPaneData } from "./pr-pane-data";
import { formatPrTabLabel } from "./pr-tab-label";

function makePrPaneData(overrides: Partial<PrPaneData> = {}): PrPaneData {
  return {
    number: 42,
    title: "Sample PR",
    state: "open",
    url: "https://github.com/getpaseo/paseo/pull/42",
    reviewDecision: "pending",
    awaitingReviewers: [],
    checks: [],
    activity: [],
    ...overrides,
  };
}

describe("formatPrTabLabel", () => {
  it("returns #<number> when data is present", () => {
    expect(formatPrTabLabel(makePrPaneData({ number: 42 }))).toBe("#42");
  });

  it("returns #— fallback when data is null", () => {
    expect(formatPrTabLabel(null)).toBe("#—");
  });
});
