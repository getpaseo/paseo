import { describe, expect, it } from "vitest";
import type { TrailAnchorSnapshot } from "./message-trail-anchor";
import {
  anchorOpacityFor,
  DEFAULT_TICK_SPACING,
  gaussianWeight,
  MAGNIFY_ACTIVATION,
  MIN_CONTENT_INSET_FOR_RAIL,
  MIN_PANE_HEIGHT_FOR_RAIL,
  MIN_TICK_SPACING,
  OPACITY_CURRENT,
  OPACITY_REST,
  RAIL_EDGE_MIN,
  railFits,
  resolveNearestTickIndex,
  resolveRailLeft,
  resolveTickSpacing,
  twoSigmaSqFor,
} from "./message-trail-rail-geometry";

function snapshot(currentId: string | null): TrailAnchorSnapshot {
  // The rail only reads `currentId` for opacity — that is the whole snapshot shape now.
  return { currentId };
}

describe("resolveRailLeft", () => {
  it("centers a wide inset with a nudge toward the pane edge", () => {
    // desired = 120/2 - 20/2 - 6 = 44; maxLeft = 120 - 20 - 6 = 94; min(44, 94) = 44.
    expect(resolveRailLeft(120)).toBe(44);
  });

  it("clamps a tiny inset up to the edge minimum", () => {
    // desired = 10/2 - 10 - 6 = -11; clamped up to RAIL_EDGE_MIN.
    expect(resolveRailLeft(10)).toBe(RAIL_EDGE_MIN);
  });

  it("caps the desired position at the content-edge clamp", () => {
    // At inset 60 the content-edge clamp (maxLeft = 60 - 20 - 6 = 34) sits above the
    // desired midpoint (30 - 10 - 6 = 14), so the desired position is used unchanged.
    expect(resolveRailLeft(60)).toBe(14);
    // The clamp is what keeps the rail off the content: min(desired, maxLeft) can never
    // exceed maxLeft, i.e. left + RAIL_WIDTH + MIN_GAP_TO_CONTENT never crosses the inset.
    expect(resolveRailLeft(60)).toBeLessThanOrEqual(60 - 20 - 6);
  });

  it("returns the edge minimum for zero inset", () => {
    expect(resolveRailLeft(0)).toBe(RAIL_EDGE_MIN);
  });
});

describe("resolveTickSpacing", () => {
  it("returns the default for a single tick", () => {
    expect(resolveTickSpacing(1, 1000)).toBe(DEFAULT_TICK_SPACING);
  });

  it("returns the default for zero ticks", () => {
    expect(resolveTickSpacing(0, 1000)).toBe(DEFAULT_TICK_SPACING);
  });

  it("returns the default for zero available height", () => {
    expect(resolveTickSpacing(50, 0)).toBe(DEFAULT_TICK_SPACING);
  });

  it("caps at the default when there is ample room", () => {
    // fitSpacing = (10000 - 2) / (10 - 1) ~= 1111, capped down to DEFAULT_TICK_SPACING.
    expect(resolveTickSpacing(10, 10000)).toBe(DEFAULT_TICK_SPACING);
  });

  it("compresses many ticks to fit the available height", () => {
    // 11 ticks over height 62: fitSpacing = (62 - 2) / (11 - 1) = 6 -> below default, kept.
    expect(resolveTickSpacing(11, 62)).toBe(6);
  });

  it("floors at the minimum tick spacing when compression would go below it", () => {
    // 101 ticks over height 102: fitSpacing = (102 - 2) / 100 = 1 -> floored to MIN.
    expect(resolveTickSpacing(101, 102)).toBe(MIN_TICK_SPACING);
  });

  it("returns exactly the default at the boundary where fit equals default", () => {
    // 11 ticks over height 102: fitSpacing = (102 - 2) / 10 = 10 == DEFAULT_TICK_SPACING.
    expect(resolveTickSpacing(11, 102)).toBe(DEFAULT_TICK_SPACING);
  });
});

describe("twoSigmaSqFor", () => {
  it("computes 2*(0.5*spacing)^2 for spacing 10", () => {
    // sigma = 5, 2*25 = 50.
    expect(twoSigmaSqFor(10)).toBe(50);
  });

  it("scales with the square of spacing", () => {
    // spacing 20 -> sigma 10 -> 2*100 = 200 = 50 * 4.
    expect(twoSigmaSqFor(20)).toBe(200);
    expect(twoSigmaSqFor(20)).toBe(twoSigmaSqFor(10) * 4);
  });

  it("is zero for zero spacing", () => {
    expect(twoSigmaSqFor(0)).toBe(0);
  });
});

describe("gaussianWeight", () => {
  it("is exactly 1 at zero distance", () => {
    expect(gaussianWeight(0, 50)).toBe(1);
  });

  it("decays with distance", () => {
    // exp(-(5*5)/50) = exp(-0.5).
    expect(gaussianWeight(5, 50)).toBeCloseTo(Math.exp(-0.5), 12);
  });

  it("falls below the magnify activation threshold far from the pointer", () => {
    // At distance 20 with twoSigmaSq 50: exp(-400/50) = exp(-8) ~= 3.4e-4 < 0.02.
    expect(gaussianWeight(20, 50)).toBeLessThan(MAGNIFY_ACTIVATION);
  });
});

describe("anchorOpacityFor", () => {
  it("lights the current tick", () => {
    expect(anchorOpacityFor("b", snapshot("b"))).toBe(OPACITY_CURRENT);
  });

  it("rests a non-current tick", () => {
    expect(anchorOpacityFor("a", snapshot("b"))).toBe(OPACITY_REST);
  });

  it("rests every tick when there is no current id", () => {
    expect(anchorOpacityFor("a", snapshot(null))).toBe(OPACITY_REST);
  });
});

describe("railFits", () => {
  it("fits exactly at both thresholds", () => {
    expect(railFits(MIN_CONTENT_INSET_FOR_RAIL, MIN_PANE_HEIGHT_FOR_RAIL)).toBe(true);
  });

  it("does not fit below the inset threshold", () => {
    expect(railFits(MIN_CONTENT_INSET_FOR_RAIL - 1, MIN_PANE_HEIGHT_FOR_RAIL)).toBe(false);
  });

  it("does not fit below the height threshold", () => {
    expect(railFits(MIN_CONTENT_INSET_FOR_RAIL, MIN_PANE_HEIGHT_FOR_RAIL - 1)).toBe(false);
  });

  it("does not fit for a zero-size pane", () => {
    expect(railFits(0, 0)).toBe(false);
  });
});

describe("resolveNearestTickIndex", () => {
  it("picks the tick whose center is nearest the pointer", () => {
    // Centers with spacing 10: 1, 11, 21, 31, 41. Pointer 23 -> nearest center 21 (index 2).
    expect(resolveNearestTickIndex(23, 5, 10)).toBe(2);
  });

  it("clamps to the first tick for a pointer above the range", () => {
    expect(resolveNearestTickIndex(-100, 5, 10)).toBe(0);
  });

  it("clamps to the last tick for a pointer below the range", () => {
    expect(resolveNearestTickIndex(1000, 5, 10)).toBe(4);
  });

  it("returns -1 for an empty set", () => {
    expect(resolveNearestTickIndex(50, 0, 10)).toBe(-1);
  });

  it("breaks ties toward the earlier tick", () => {
    // Centers 1 and 11 (spacing 10); pointer at 6 is equidistant (5 from each).
    // Strict `<` keeps the first-seen index 0.
    expect(resolveNearestTickIndex(6, 2, 10)).toBe(0);
  });
});
