import { describe, expect, it } from "vitest";
import { computeOverlayScrollbarGeometry, scrollOffsetFromThumbDrag } from "./geometry";

describe("computeOverlayScrollbarGeometry", () => {
  it("hides the thumb when the content fits", () => {
    expect(
      computeOverlayScrollbarGeometry({ viewportSize: 500, contentSize: 500, offset: 0 }),
    ).toEqual({
      isVisible: false,
      maxScrollOffset: 0,
      thumbSize: 0,
      thumbOffset: 0,
      maxThumbOffset: 0,
    });
  });

  it("places a proportional thumb for overflowing content", () => {
    expect(
      computeOverlayScrollbarGeometry({ viewportSize: 500, contentSize: 2000, offset: 375 }),
    ).toEqual({
      isVisible: true,
      maxScrollOffset: 1500,
      thumbSize: 125,
      thumbOffset: 93.75,
      maxThumbOffset: 375,
    });
  });
});

describe("scrollOffsetFromThumbDrag", () => {
  it("maps thumb travel to the scroll range and clamps it", () => {
    expect(
      scrollOffsetFromThumbDrag({
        startOffset: 250,
        dragDelta: 50,
        maxScrollOffset: 1000,
        maxThumbOffset: 200,
      }),
    ).toBe(500);
    expect(
      scrollOffsetFromThumbDrag({
        startOffset: 900,
        dragDelta: 1000,
        maxScrollOffset: 1000,
        maxThumbOffset: 200,
      }),
    ).toBe(1000);
  });
});
