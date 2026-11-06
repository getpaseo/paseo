import { describe, expect, test } from "vitest";
import {
  SYNCED_LOADER_DOT_COUNT,
  SYNCED_LOADER_PEAK_OPACITY,
  SYNCED_LOADER_PERIOD_MS,
  getSyncedLoaderDotFrames,
  getSyncedLoaderDotOpacity,
  getSyncedLoaderElapsed,
} from "./synced-loader-state";

describe("synced loader state", () => {
  test("aligns every loader to one wall-clock cycle", () => {
    expect(getSyncedLoaderElapsed(0)).toBe(0);
    expect(getSyncedLoaderElapsed(SYNCED_LOADER_PERIOD_MS)).toBe(0);
    expect(getSyncedLoaderElapsed(SYNCED_LOADER_PERIOD_MS * 3 + 200)).toBe(200);
  });

  test("pulses dots down each column before moving right", () => {
    // Dots are indexed row by row: 0 1 2 / 3 4 5 / 6 7 8. At 200ms the first column (0, 3, 6) is
    // lit and the second column is only starting at its top (1). A row-major pulse would instead
    // light the top row (0, 1, 2).
    const opacityAt200 = (dot: number) => getSyncedLoaderDotOpacity(200, dot);

    expect(opacityAt200(0)).toBe(SYNCED_LOADER_PEAK_OPACITY);
    expect(opacityAt200(3)).toBeGreaterThan(0);
    expect(opacityAt200(6)).toBeGreaterThan(0);
    expect(opacityAt200(1)).toBeGreaterThan(0);
    expect(opacityAt200(4)).toBe(0);
    expect(opacityAt200(7)).toBe(0);
    expect(opacityAt200(2)).toBe(0);
  });

  test("fades every dot out completely before the next cycle", () => {
    for (let dot = 0; dot < SYNCED_LOADER_DOT_COUNT; dot += 1) {
      expect(getSyncedLoaderDotOpacity(1_000, dot)).toBe(0);
    }
  });

  test("fills the requested size with a square grid", () => {
    const frames = getSyncedLoaderDotFrames(12);
    const last = frames[SYNCED_LOADER_DOT_COUNT - 1];

    expect(frames).toHaveLength(SYNCED_LOADER_DOT_COUNT);
    expect(frames[0]).toMatchObject({ left: 0, top: 0 });
    expect(last.left + last.size).toBeCloseTo(12);
    expect(last.top + last.size).toBeCloseTo(12);
  });
});
