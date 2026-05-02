import { describe, expect, it } from "vitest";
import { getNativeScrollToIndexFallbackOffset } from "./stream-strategy-native";

describe("getNativeScrollToIndexFallbackOffset", () => {
  it("approximates the offset for an unmeasured native FlatList row", () => {
    expect(
      getNativeScrollToIndexFallbackOffset({
        index: 25,
        highestMeasuredFrameIndex: 4,
        averageItemLength: 72,
      }),
    ).toBe(1800);
  });

  it("falls back to the start when the average item length is not useful", () => {
    expect(
      getNativeScrollToIndexFallbackOffset({
        index: 25,
        highestMeasuredFrameIndex: 4,
        averageItemLength: 0,
      }),
    ).toBe(0);
    expect(
      getNativeScrollToIndexFallbackOffset({
        index: 25,
        highestMeasuredFrameIndex: 4,
        averageItemLength: Number.NaN,
      }),
    ).toBe(0);
  });
});
