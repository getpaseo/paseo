import { describe, expect, it } from "vitest";
import { resolveSliderFraction, resolveSliderIndexFromX } from "./stepped-slider-math";

describe("stepped slider math", () => {
  it("computes normalized stop positions across the track", () => {
    expect(resolveSliderFraction(0, 5)).toBe(0);
    expect(resolveSliderFraction(2, 5)).toBe(0.5);
    expect(resolveSliderFraction(4, 5)).toBe(1);
    expect(resolveSliderFraction(-1, 5)).toBe(0);
    expect(resolveSliderFraction(9, 5)).toBe(1);
    expect(resolveSliderFraction(0, 1)).toBe(0);
  });

  it("snaps drag positions to the nearest stop and clamps out-of-bounds drags", () => {
    expect(resolveSliderIndexFromX(-20, 200, 5)).toBe(0);
    expect(resolveSliderIndexFromX(0, 200, 5)).toBe(0);
    expect(resolveSliderIndexFromX(24, 200, 5)).toBe(0);
    expect(resolveSliderIndexFromX(26, 200, 5)).toBe(1);
    expect(resolveSliderIndexFromX(100, 200, 5)).toBe(2);
    expect(resolveSliderIndexFromX(190, 200, 5)).toBe(4);
    expect(resolveSliderIndexFromX(260, 200, 5)).toBe(4);
    expect(resolveSliderIndexFromX(50, 0, 5)).toBe(0);
  });
});
