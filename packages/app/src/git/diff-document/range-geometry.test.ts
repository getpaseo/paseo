import { describe, expect, it } from "vitest";
import type { DiffFragment } from "./types";
import {
  firstRangeEndingAfter,
  fragmentRangeBounds,
  type RangeMeasurements,
} from "./range-geometry";

describe("diff range geometry", () => {
  it("measures a long fragment once per paint, not once per match", () => {
    let widthReads = 0;
    const fragment: DiffFragment = {
      start: 0,
      end: 10_000,
      text: "a".repeat(10_000),
      width: 10_000,
      top: 0,
      baseline: 14,
      graphemes: Array.from({ length: 10_000 }, (_, index) => ({
        start: index,
        end: index + 1,
        text: "a",
        get width() {
          widthReads++;
          return 1;
        },
      })),
    };
    const measurements: RangeMeasurements = new WeakMap();
    for (let start = 0; start < 1000; start++) {
      expect(fragmentRangeBounds({ fragment, start, end: start + 1, measurements })).toEqual({
        before: start,
        width: 1,
      });
    }
    expect(widthReads).toBe(10_000);
  });

  it("finds fragment boundaries without skipping a match at the start", () => {
    const fragments = [
      { start: 0, end: 5 },
      { start: 5, end: 10 },
    ];
    expect(firstRangeEndingAfter(fragments, 0)).toBe(0);
    expect(firstRangeEndingAfter(fragments, 4)).toBe(0);
    expect(firstRangeEndingAfter(fragments, 5)).toBe(1);
    expect(firstRangeEndingAfter(fragments, 10)).toBe(2);
  });
});
