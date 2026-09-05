import { describe, expect, it } from "vitest";
import { summarizeFrameGaps } from "./benchmark-support";

describe("summarizeFrameGaps", () => {
  it("separates delayed intervals from estimated dropped frames", () => {
    expect(summarizeFrameGaps([1000 / 60, 1000 / 30, 1000])).toEqual({
      delayedFrameIntervals: 2,
      estimatedDroppedFrames: 60,
      maxFrameGapMs: 1000,
    });
  });

  it("returns zero counts for an empty sample", () => {
    expect(summarizeFrameGaps([])).toEqual({
      delayedFrameIntervals: 0,
      estimatedDroppedFrames: 0,
      maxFrameGapMs: 0,
    });
  });
});
