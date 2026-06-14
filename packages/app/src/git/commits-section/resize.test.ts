import { describe, expect, it } from "vitest";
import {
  clampCommitsSectionHeight,
  commitsSectionHeightBounds,
  COMMITS_SECTION_DIFF_RESERVE,
  COMMITS_SECTION_MAX_HEIGHT,
  COMMITS_SECTION_MIN_HEIGHT,
} from "./resize";

describe("commitsSectionHeightBounds", () => {
  it("uses the static ceiling when the container is unmeasured", () => {
    expect(commitsSectionHeightBounds(0)).toEqual({
      min: COMMITS_SECTION_MIN_HEIGHT,
      max: COMMITS_SECTION_MAX_HEIGHT,
    });
  });

  it("reserves room for the diff when the container is tall", () => {
    // 900 - 160 = 740, capped to the static ceiling 600.
    expect(commitsSectionHeightBounds(900)).toEqual({
      min: COMMITS_SECTION_MIN_HEIGHT,
      max: COMMITS_SECTION_MAX_HEIGHT,
    });
  });

  it("caps the max below the ceiling when the container is short", () => {
    // 400 - 160 = 240 leaves the diff its reserve.
    expect(commitsSectionHeightBounds(400)).toEqual({
      min: COMMITS_SECTION_MIN_HEIGHT,
      max: 400 - COMMITS_SECTION_DIFF_RESERVE,
    });
  });

  it("never lets the max fall below the min on a tiny container", () => {
    const bounds = commitsSectionHeightBounds(120);
    expect(bounds.max).toBe(COMMITS_SECTION_MIN_HEIGHT);
    expect(bounds.max).toBeGreaterThanOrEqual(bounds.min);
  });
});

describe("clampCommitsSectionHeight", () => {
  const bounds = { min: 96, max: 600 };

  it("returns the value when within bounds", () => {
    expect(clampCommitsSectionHeight(240, bounds)).toBe(240);
  });

  it("clamps below the minimum", () => {
    expect(clampCommitsSectionHeight(10, bounds)).toBe(96);
  });

  it("clamps above the maximum", () => {
    expect(clampCommitsSectionHeight(5000, bounds)).toBe(600);
  });

  it("falls back to the minimum for NaN", () => {
    expect(clampCommitsSectionHeight(Number.NaN, bounds)).toBe(96);
  });
});
