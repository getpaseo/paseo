import { describe, expect, it } from "vitest";
import {
  cacheHitTone,
  computeCacheHitPercent,
  formatMetricCost,
  formatMetricDuration,
  formatMetricRate,
  formatMetricTokens,
  formatTokenPair,
  mergeTimeIntervals,
} from "./metrics.js";

describe("formatMetricDuration", () => {
  it.each([
    [1, "<0.1s"],
    [49, "<0.1s"],
    [50, "0.1s"],
    [0, "0.0s"],
    [1_240, "1.2s"],
    [12_350, "12.4s"],
    [59_940, "59.9s"],
    [59_960, "1m 0s"],
    [60_000, "1m 0s"],
    [125_400, "2m 5s"],
    [3_725_000, "62m 5s"],
  ])("shows %dms as %s", (ms, expected) => {
    expect(formatMetricDuration(ms)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("has nothing to show for %d", (ms) => {
    expect(formatMetricDuration(ms)).toBeNull();
  });
});

describe("formatMetricTokens", () => {
  it.each([
    [0, "0"],
    [7, "7"],
    [999, "999"],
    [999.6, "1.0K"],
    [1_000, "1.0K"],
    [1_234, "1.2K"],
    [18_900, "18.9K"],
    [999_949, "999.9K"],
    [999_950, "1.0M"],
    [1_234_567, "1.2M"],
    [2_500_000_000, "2500.0M"],
  ])("shows %d as %s", (tokens, expected) => {
    expect(formatMetricTokens(tokens)).toBe(expected);
  });

  it.each([-5, Number.NaN, Number.POSITIVE_INFINITY])("counts %d as no tokens", (tokens) => {
    expect(formatMetricTokens(tokens)).toBe("0");
  });
});

describe("formatTokenPair", () => {
  it("shows input going up and output coming down", () => {
    expect(formatTokenPair(18_900, 2_300)).toBe("18.9K ↑ · 2.3K ↓");
    expect(formatTokenPair(120, 0)).toBe("120 ↑ · 0 ↓");
  });
});

describe("formatMetricRate", () => {
  it.each([
    [163.4, "~163 tok/s"],
    [1, "~1 tok/s"],
    [5_000, "~5000 tok/s"],
  ])("shows %d as %s", (rate, expected) => {
    expect(formatMetricRate(rate)).toBe(expected);
  });

  it.each([0, -3, 0.2, 5_000.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "has no believable rate for %d",
    (rate) => {
      expect(formatMetricRate(rate)).toBeNull();
    },
  );
});

describe("formatMetricCost", () => {
  it.each([
    [0.042, "$0.042"],
    [0.0421, "$0.042"],
    [0.5, "$0.500"],
    [0.0004, "<$0.001"],
    [0.9996, "$1.00"],
    [1.234, "$1.23"],
    [1234.5, "$1234.50"],
  ])("shows %d as %s", (usd, expected) => {
    expect(formatMetricCost(usd)).toBe(expected);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("has no cost for %d", (usd) => {
    expect(formatMetricCost(usd)).toBeNull();
  });
});

describe("computeCacheHitPercent", () => {
  it("is the share of prompt tokens read from cache", () => {
    expect(computeCacheHitPercent({ input: 100, cacheRead: 820, cacheWrite: 80 })).toBe(82);
    expect(computeCacheHitPercent({ input: 2, cacheRead: 1, cacheWrite: 0 })).toBe(33);
    expect(computeCacheHitPercent({ input: 100, cacheRead: 0, cacheWrite: 0 })).toBe(0);
    expect(computeCacheHitPercent({ input: 0, cacheRead: 500, cacheWrite: 0 })).toBe(100);
  });

  it("is unknown when the turn sent no prompt tokens", () => {
    expect(computeCacheHitPercent({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });

  it("is unknown when a count is not a usable number", () => {
    expect(computeCacheHitPercent({ input: Number.NaN, cacheRead: 10, cacheWrite: 0 })).toBeNull();
    expect(computeCacheHitPercent({ input: 10, cacheRead: -4, cacheWrite: 0 })).toBeNull();
  });

  it("marks a cache that served at least half the prompt as good", () => {
    expect(cacheHitTone(50)).toBe("ok");
    expect(cacheHitTone(82)).toBe("ok");
    expect(cacheHitTone(49)).toBeUndefined();
  });
});

describe("mergeTimeIntervals", () => {
  it("unions overlapping and touching intervals so shared time counts once", () => {
    expect(
      mergeTimeIntervals([
        [50, 80],
        [0, 10],
        [5, 20],
        [20, 30],
        [60, 70],
      ]),
    ).toEqual([
      [0, 30],
      [50, 80],
    ]);
  });

  it("keeps separate intervals apart", () => {
    expect(
      mergeTimeIntervals([
        [0, 1],
        [2, 3],
      ]),
    ).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(mergeTimeIntervals([])).toEqual([]);
  });

  it("drops intervals that never ran forward", () => {
    expect(
      mergeTimeIntervals([
        [10, 5],
        [Number.NaN, 4],
        [1, 2],
      ]),
    ).toEqual([[1, 2]]);
  });

  it("leaves the caller's intervals untouched", () => {
    const intervals: [number, number][] = [
      [5, 9],
      [0, 6],
    ];
    mergeTimeIntervals(intervals);
    expect(intervals).toEqual([
      [5, 9],
      [0, 6],
    ]);
  });
});
