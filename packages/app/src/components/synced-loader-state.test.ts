import { describe, expect, test } from "vitest";
import { getSyncedLoaderProgress, getSyncedLoaderPulse } from "./synced-loader-state";

describe("synced loader state", () => {
  test("breathes from dim/small to bright/large and back on a 1.8s cycle", () => {
    expect(getSyncedLoaderProgress(0)).toBeCloseTo(0, 5);
    expect(getSyncedLoaderProgress(450)).toBeCloseTo(0.5, 5);
    expect(getSyncedLoaderProgress(900)).toBeCloseTo(1, 5);
    expect(getSyncedLoaderProgress(1350)).toBeCloseTo(0.5, 5);
    expect(getSyncedLoaderProgress(1800)).toBeCloseTo(0, 5);
  });

  test("maps progress onto scale and opacity", () => {
    expect(getSyncedLoaderPulse(0)).toEqual({ scale: 0.55, opacity: 0.28 });
    expect(getSyncedLoaderPulse(1)).toEqual({ scale: 1, opacity: 1 });
    expect(getSyncedLoaderPulse(0.5)).toEqual({ scale: 0.775, opacity: 0.64 });
  });
});
