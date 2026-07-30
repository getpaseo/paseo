import { describe, expect, test } from "vitest";
import { largestFittingProjectedLimit } from "./timeline-page-bounds.js";

describe("largestFittingProjectedLimit", () => {
  test("returns maxLimit unchanged when the full page already fits", () => {
    const result = largestFittingProjectedLimit({
      maxLimit: 40,
      budgetBytes: 1_000_000,
      measurePageBytes: (limit) => limit * 100,
    });
    expect(result).toBe(40);
  });

  test("returns the largest limit whose page fits the budget", () => {
    // page grows 1000 bytes per item; a 3500-byte budget fits 3.
    const result = largestFittingProjectedLimit({
      maxLimit: 10,
      budgetBytes: 3500,
      measurePageBytes: (limit) => limit * 1000,
    });
    expect(result).toBe(3);
  });

  test("respects a non-linear jump when projection expands past a threshold", () => {
    // A wide entry beyond limit 3 balloons the page (contiguity expansion).
    const result = largestFittingProjectedLimit({
      maxLimit: 10,
      budgetBytes: 4000,
      measurePageBytes: (limit) => (limit <= 3 ? 1000 : 9000),
    });
    expect(result).toBe(3);
  });

  test("falls back to 1 when even the smallest page exceeds the budget", () => {
    const result = largestFittingProjectedLimit({
      maxLimit: 10,
      budgetBytes: 500,
      measurePageBytes: (limit) => limit * 1000,
    });
    expect(result).toBe(1);
  });

  test("handles a trivial page without measuring", () => {
    let calls = 0;
    const measurePageBytes = (limit: number): number => {
      calls += 1;
      return limit * 1000;
    };
    expect(largestFittingProjectedLimit({ maxLimit: 1, budgetBytes: 1, measurePageBytes })).toBe(1);
    expect(largestFittingProjectedLimit({ maxLimit: 0, budgetBytes: 1, measurePageBytes })).toBe(0);
    expect(calls).toBe(0);
  });
});
