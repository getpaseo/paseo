import { describe, expect, it } from "vitest";
import { clampActiveIndex, stepActiveIndex } from "./model";

describe("stepActiveIndex", () => {
  it("has nothing to step to without matches", () => {
    expect(stepActiveIndex({ activeIndex: null, count: 0, delta: 1 })).toBeNull();
    expect(stepActiveIndex({ activeIndex: null, count: 0, delta: -1 })).toBeNull();
  });

  it("starts at the first match going forward and the last going back", () => {
    expect(stepActiveIndex({ activeIndex: null, count: 4, delta: 1 })).toBe(0);
    expect(stepActiveIndex({ activeIndex: null, count: 4, delta: -1 })).toBe(3);
  });

  it("advances and retreats within the list", () => {
    expect(stepActiveIndex({ activeIndex: 1, count: 4, delta: 1 })).toBe(2);
    expect(stepActiveIndex({ activeIndex: 2, count: 4, delta: -1 })).toBe(1);
  });

  it("wraps around at both ends", () => {
    expect(stepActiveIndex({ activeIndex: 3, count: 4, delta: 1 })).toBe(0);
    expect(stepActiveIndex({ activeIndex: 0, count: 4, delta: -1 })).toBe(3);
  });

  it("stays on the only match in a single-match list", () => {
    expect(stepActiveIndex({ activeIndex: 0, count: 1, delta: 1 })).toBe(0);
    expect(stepActiveIndex({ activeIndex: 0, count: 1, delta: -1 })).toBe(0);
  });
});

describe("clampActiveIndex", () => {
  it("drops the pointer when the matches are gone", () => {
    expect(clampActiveIndex(2, 0)).toBeNull();
    expect(clampActiveIndex(null, 5)).toBeNull();
  });

  it("keeps a pointer that is still in range", () => {
    expect(clampActiveIndex(2, 5)).toBe(2);
  });

  it("pulls a pointer past the end back onto the last match", () => {
    expect(clampActiveIndex(7, 3)).toBe(2);
  });
});
