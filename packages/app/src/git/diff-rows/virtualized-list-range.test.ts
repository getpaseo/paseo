import { describe, expect, it } from "vitest";
import { boundRetainedRangeOnDataGrowth } from "@react-native/virtualized-lists/Lists/boundRetainedRangeOnDataGrowth";

describe("bounded VirtualizedList data growth", () => {
  it("limits the carried range when middle insertion grows the list", () => {
    expect(boundRetainedRangeOnDataGrowth({ first: 0, last: 39 }, 40, 115, 16)).toEqual({
      first: 0,
      last: 15,
    });
  });

  it("bounds from the current scrolled range instead of jumping to the start", () => {
    expect(boundRetainedRangeOnDataGrowth({ first: 84, last: 123 }, 160, 235, 16)).toEqual({
      first: 84,
      last: 99,
    });
  });

  it("does not alter the range when data shrinks or the carried range is already bounded", () => {
    const shortRange = { first: 12, last: 18 };
    expect(boundRetainedRangeOnDataGrowth(shortRange, 40, 32, 16)).toBe(shortRange);
    expect(boundRetainedRangeOnDataGrowth(shortRange, 40, 115, 16)).toEqual(shortRange);
  });
});
