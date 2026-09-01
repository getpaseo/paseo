import { describe, expect, it } from "vitest";

import { summarizeStreamSmoothness } from "./stream-smoothness";

describe("summarizeStreamSmoothness", () => {
  it("reports canonical handover snaps separately from paced growth", () => {
    const report = summarizeStreamSmoothness(
      [
        { timestampMs: 0, growthChars: 0, firstPaintChars: 0 },
        { timestampMs: 10, growthChars: 4, firstPaintChars: 0 },
        { timestampMs: 20, growthChars: 100, firstPaintChars: 30 },
        { timestampMs: 30, growthChars: 4, firstPaintChars: 0 },
        { timestampMs: 40, growthChars: 0, firstPaintChars: 0 },
      ],
      40,
    );

    expect(report).toMatchObject({
      frames: 3,
      growthFrames: 2,
      charsPainted: 8,
      maxCharsInOneFrame: 4,
      firstPaintFrames: 1,
      firstPaintChars: 30,
      handoverGrowthFrames: 1,
      handoverGrowthChars: 100,
      maxHandoverGrowthCharsInOneFrame: 100,
      updateGapP95Ms: 10,
    });
  });
});
