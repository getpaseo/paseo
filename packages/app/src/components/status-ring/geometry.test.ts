import { describe, expect, test } from "vitest";
import { getStatusRingRotation } from "./geometry";

describe("status ring geometry", () => {
  test("turns in twelve wall-clock-aligned steps every 900 milliseconds", () => {
    const sampleTimes = [0, 74, 75, 149, 150, 449, 450, 824, 825, 899, 900];

    const rotations = sampleTimes.map(getStatusRingRotation);

    expect(rotations).toEqual([0, 0, 30, 30, 60, 150, 180, 300, 330, 330, 0]);
  });
});
