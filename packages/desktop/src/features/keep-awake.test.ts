import { describe, expect, it } from "vitest";

import { computeKeepAwakeState } from "./keep-awake";

describe("computeKeepAwakeState", () => {
  it("is inactive when not requested", () => {
    expect(computeKeepAwakeState({ enabled: false, batteryLevel: 0.5 })).toEqual({
      active: false,
      suppressedByLowBattery: false,
    });
  });

  it("is active when requested and battery is unknown", () => {
    expect(computeKeepAwakeState({ enabled: true, batteryLevel: null })).toEqual({
      active: true,
      suppressedByLowBattery: false,
    });
  });

  it("is active when requested and battery is above the cutoff", () => {
    expect(computeKeepAwakeState({ enabled: true, batteryLevel: 0.1 })).toEqual({
      active: true,
      suppressedByLowBattery: false,
    });
  });

  it("suppresses itself below the 10% battery cutoff even when requested", () => {
    expect(computeKeepAwakeState({ enabled: true, batteryLevel: 0.09 })).toEqual({
      active: false,
      suppressedByLowBattery: true,
    });
  });
});
