import { describe, expect, it } from "vitest";
import { LARGE_SCREEN_MIN_SHORTEST_SIDE, resolveOrientationPolicy } from "./form-factor";

const android = { isAndroid: true };

describe("resolveOrientationPolicy", () => {
  it("frees a tablet whose shortest side reaches the threshold", () => {
    expect(resolveOrientationPolicy({ ...android, screenWidth: 1280, screenHeight: 800 })).toBe(
      "follow-sensor",
    );
  });

  it("locks a phone whose shortest side is below the threshold", () => {
    expect(resolveOrientationPolicy({ ...android, screenWidth: 891, screenHeight: 411 })).toBe(
      "lock-portrait",
    );
  });

  it("treats the threshold boundary itself as large-screen", () => {
    const at = LARGE_SCREEN_MIN_SHORTEST_SIDE;
    expect(resolveOrientationPolicy({ ...android, screenWidth: 1000, screenHeight: at })).toBe(
      "follow-sensor",
    );
    expect(resolveOrientationPolicy({ ...android, screenWidth: 1000, screenHeight: at - 1 })).toBe(
      "lock-portrait",
    );
  });

  it("is orientation-insensitive", () => {
    const portrait = resolveOrientationPolicy({ ...android, screenWidth: 800, screenHeight: 1280 });
    const landscape = resolveOrientationPolicy({
      ...android,
      screenWidth: 1280,
      screenHeight: 800,
    });
    expect(portrait).toBe(landscape);
  });

  it("ignores the window, so a narrow tablet window stays a tablet", () => {
    // The screen is 1280x800 even while a floating window is 375x700.
    expect(resolveOrientationPolicy({ ...android, screenWidth: 1280, screenHeight: 800 })).not.toBe(
      "lock-portrait",
    );
  });

  it("leaves iOS and web alone", () => {
    expect(
      resolveOrientationPolicy({ isAndroid: false, screenWidth: 1280, screenHeight: 800 }),
    ).toBeNull();
    expect(
      resolveOrientationPolicy({ isAndroid: false, screenWidth: 390, screenHeight: 844 }),
    ).toBeNull();
  });
});
