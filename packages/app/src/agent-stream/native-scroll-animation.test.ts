import { describe, expect, it } from "vitest";
import { shouldAnimateNativeScrollToBottom } from "./native-scroll-animation";

describe("native scroll-to-bottom animation", () => {
  it("jumps across unmounted history instead of animating through blank rows", () => {
    expect(
      shouldAnimateNativeScrollToBottom({
        distanceFromEnd: 60_000,
        viewportHeight: 600,
        drawDistance: 2000,
      }),
    ).toBe(false);
  });

  it("keeps near-end movement eligible for animation", () => {
    expect(
      shouldAnimateNativeScrollToBottom({
        distanceFromEnd: 300,
        viewportHeight: 600,
        drawDistance: 2000,
      }),
    ).toBe(true);
  });

  it("bounds travel by the rows mounted below the viewport", () => {
    expect(
      shouldAnimateNativeScrollToBottom({
        distanceFromEnd: 1000,
        viewportHeight: 600,
        drawDistance: 2000,
      }),
    ).toBe(true);
    expect(
      shouldAnimateNativeScrollToBottom({
        distanceFromEnd: 1001,
        viewportHeight: 600,
        drawDistance: 2000,
      }),
    ).toBe(false);
  });

  it("does not animate before the viewport has been measured", () => {
    expect(
      shouldAnimateNativeScrollToBottom({
        distanceFromEnd: 0,
        viewportHeight: 0,
        drawDistance: 2000,
      }),
    ).toBe(false);
  });
});
