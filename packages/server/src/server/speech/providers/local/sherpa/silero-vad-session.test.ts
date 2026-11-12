import { describe, expect, test } from "vitest";

import { windowLevelDbfs } from "./silero-vad-session.js";

function tone(amplitude: number): Float32Array {
  return Float32Array.from({ length: 512 }, (_, i) => amplitude * Math.sin((2 * Math.PI * i) / 32));
}

describe("windowLevelDbfs", () => {
  test("measures a full-scale sine at about -3 dBFS", () => {
    expect(windowLevelDbfs(tone(1))).toBeCloseTo(-3.01, 1);
  });

  test("puts a talker's level above the detector's gate and echo residue below it", () => {
    // Measured on an iPhone speakerphone: speech -10 to -30 dBFS, echo residue -64 dBFS and below.
    expect(windowLevelDbfs(tone(0.05))).toBeGreaterThan(-55);
    expect(windowLevelDbfs(tone(0.0008))).toBeLessThan(-55);
  });

  test("treats digital silence and an empty window as infinitely quiet", () => {
    expect(windowLevelDbfs(new Float32Array(512))).toBe(-Infinity);
    expect(windowLevelDbfs(new Float32Array(0))).toBe(-Infinity);
  });
});
