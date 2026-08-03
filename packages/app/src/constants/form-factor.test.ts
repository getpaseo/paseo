import { describe, expect, it } from "vitest";
import {
  LARGE_SCREEN_MIN_SHORTEST_SIDE,
  computeIsCompactFormFactor,
  isLargeScreenShortestSide,
} from "./form-factor";

describe("isLargeScreenShortestSide", () => {
  it("treats the threshold shortest side as large-screen", () => {
    expect(isLargeScreenShortestSide(LARGE_SCREEN_MIN_SHORTEST_SIDE)).toBe(true);
  });

  it("treats one dp below the threshold as not large-screen", () => {
    expect(isLargeScreenShortestSide(LARGE_SCREEN_MIN_SHORTEST_SIDE - 1)).toBe(false);
  });

  it("treats a typical phone shortest side as small", () => {
    expect(isLargeScreenShortestSide(390)).toBe(false);
  });

  it("treats an unfolded foldable shortest side as large", () => {
    expect(isLargeScreenShortestSide(760)).toBe(true);
  });
});

describe("computeIsCompactFormFactor", () => {
  it("stays compact single-pane for a phone in portrait (narrow breakpoint, small screen, native)", () => {
    expect(
      computeIsCompactFormFactor({ compactBreakpoint: true, largeScreenForm: false, native: true }),
    ).toBe(true);
  });

  it("goes two-pane for an unfolded foldable in portrait (narrow breakpoint, large screen, native)", () => {
    expect(
      computeIsCompactFormFactor({ compactBreakpoint: true, largeScreenForm: true, native: true }),
    ).toBe(false);
  });

  it("goes two-pane for a wide breakpoint (tablet or large window)", () => {
    expect(
      computeIsCompactFormFactor({ compactBreakpoint: false, largeScreenForm: true, native: true }),
    ).toBe(false);
  });

  it("stays compact on web/desktop for a narrow tall window despite a large physical screen", () => {
    expect(
      computeIsCompactFormFactor({ compactBreakpoint: true, largeScreenForm: true, native: false }),
    ).toBe(true);
  });
});
