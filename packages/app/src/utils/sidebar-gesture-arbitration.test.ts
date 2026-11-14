import { describe, expect, it } from "vitest";

import { didPressMove } from "./sidebar-gesture-arbitration";

const start = { x: 0, y: 0 };

describe("didPressMove", () => {
  it("keeps a small movement a tap", () => {
    expect(didPressMove({ startPoint: start, currentPoint: { x: 3, y: 2 } })).toBe(false);
  });

  it("counts movement past the cancel slop", () => {
    expect(didPressMove({ startPoint: start, currentPoint: { x: 8, y: 8 } })).toBe(true);
  });

  it("counts a clearly vertical move sooner, as a scroll", () => {
    expect(didPressMove({ startPoint: start, currentPoint: { x: 2, y: 7 } })).toBe(true);
  });

  it("keeps a short diagonal move a tap", () => {
    expect(didPressMove({ startPoint: start, currentPoint: { x: 5, y: 7 } })).toBe(false);
  });

  it("counts a clearly horizontal move sooner, as a swipe", () => {
    expect(didPressMove({ startPoint: start, currentPoint: { x: -10, y: 2 } })).toBe(true);
  });
});
