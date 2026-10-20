import { describe, expect, test } from "vitest";
import {
  SYNCED_LOADER_DURATION_MS,
  SYNCED_LOADER_MAX_OPACITY,
  getSyncedLoaderDotOpacity,
  getSyncedLoaderElapsed,
} from "./synced-loader-state";

describe("synced loader state", () => {
  test("aligns all loader instances to one wall-clock cycle", () => {
    expect(getSyncedLoaderElapsed(0)).toBe(0);
    expect(getSyncedLoaderElapsed(SYNCED_LOADER_DURATION_MS)).toBe(0);
    expect(getSyncedLoaderElapsed(SYNCED_LOADER_DURATION_MS + 200)).toBe(200);
  });

  test("pulses dots in column-major order", () => {
    // Dot 0 peaks, its column-mates below it are already fading, and the second column has only
    // just begun. A row-major delay would instead put dots 0-2 (the top row) all in the air.
    const at = (elapsed: number, dot: number) => getSyncedLoaderDotOpacity(elapsed, dot);

    expect(at(200, 0)).toBe(SYNCED_LOADER_MAX_OPACITY);
    expect(at(200, 3)).toBeGreaterThan(0);
    expect(at(200, 6)).toBeGreaterThan(0);
    expect(at(200, 1)).toBeGreaterThan(0);
    expect(at(200, 4)).toBe(0);
    expect(at(200, 7)).toBe(0);
  });

  test("fades every dot completely between pulses", () => {
    for (let dot = 0; dot < 9; dot += 1) {
      expect(getSyncedLoaderDotOpacity(1_000, dot)).toBe(0);
    }
  });
});
