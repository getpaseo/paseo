import { describe, expect, it } from "vitest";
import { floatingHeaderOverlayClearance } from "./clearance";

describe("floating header overlay clearance", () => {
  it("keeps stationary status overlays 12 points below the measured header", () => {
    for (const headerHeight of [72, 108, 132]) {
      const toastTop = floatingHeaderOverlayClearance(true, headerHeight) + 12;
      expect(toastTop).toBe(headerHeight + 12);
    }
  });

  it("adds no clearance when the header is in flow or hidden for fullscreen", () => {
    expect(floatingHeaderOverlayClearance(false, 108)).toBe(0);
    expect(floatingHeaderOverlayClearance(false, 0)).toBe(0);
  });
});
