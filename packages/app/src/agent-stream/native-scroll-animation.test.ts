import { describe, expect, it } from "vitest";
import { shouldAnimateNativeScrollToBottom } from "./native-scroll-animation";

describe("native scroll-to-bottom animation", () => {
  it("jumps across unmounted history instead of animating through blank rows", () => {
    expect(
      shouldAnimateNativeScrollToBottom({ offsetY: 60_000, viewportHeight: 600, windowSize: 10 }),
    ).toBe(false);
  });

  it("keeps near-bottom movement eligible for animation", () => {
    expect(
      shouldAnimateNativeScrollToBottom({ offsetY: 300, viewportHeight: 600, windowSize: 10 }),
    ).toBe(true);
  });

  it("bounds travel by the bottom-side overscan, not the whole window", () => {
    expect(
      shouldAnimateNativeScrollToBottom({ offsetY: 2700, viewportHeight: 600, windowSize: 10 }),
    ).toBe(true);
    expect(
      shouldAnimateNativeScrollToBottom({ offsetY: 2701, viewportHeight: 600, windowSize: 10 }),
    ).toBe(false);
    expect(
      shouldAnimateNativeScrollToBottom({ offsetY: 1500, viewportHeight: 600, windowSize: 5 }),
    ).toBe(false);
  });

  it("does not animate before the viewport has been measured", () => {
    expect(
      shouldAnimateNativeScrollToBottom({ offsetY: 0, viewportHeight: 0, windowSize: 10 }),
    ).toBe(false);
  });
});
