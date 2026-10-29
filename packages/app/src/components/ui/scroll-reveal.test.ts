import { describe, expect, it } from "vitest";
import { getScrollOffsetToRevealItem } from "./scroll-reveal";

describe("getScrollOffsetToRevealItem", () => {
  it("keeps the offset when the item is already inside the viewport", () => {
    expect(
      getScrollOffsetToRevealItem({
        currentOffset: 40,
        viewportHeight: 200,
        itemTop: 100,
        itemHeight: 40,
      }),
    ).toBe(40);
  });

  it("scrolls up to the item top when the item is above the viewport", () => {
    expect(
      getScrollOffsetToRevealItem({
        currentOffset: 300,
        viewportHeight: 200,
        itemTop: 240,
        itemHeight: 40,
      }),
    ).toBe(240);
  });

  it("scrolls down just far enough to reveal the item bottom", () => {
    expect(
      getScrollOffsetToRevealItem({
        currentOffset: 0,
        viewportHeight: 200,
        itemTop: 380,
        itemHeight: 40,
      }),
    ).toBe(220);
  });

  it("stays put before the viewport has been measured", () => {
    expect(
      getScrollOffsetToRevealItem({
        currentOffset: 120,
        viewportHeight: 0,
        itemTop: 400,
        itemHeight: 40,
      }),
    ).toBe(120);
  });
});
