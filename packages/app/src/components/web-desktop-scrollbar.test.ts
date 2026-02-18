import { describe, expect, it } from "vitest";
import {
  computeScrollOffsetFromDragDelta,
  computeVerticalScrollbarGeometry,
} from "./web-desktop-scrollbar.math";

describe("computeVerticalScrollbarGeometry", () => {
  it("returns hidden geometry when content does not overflow", () => {
    const geometry = computeVerticalScrollbarGeometry({
      viewportSize: 500,
      contentSize: 500,
      offset: 0,
      minHandleSize: 36,
    });

    expect(geometry).toEqual({
      isVisible: false,
      maxScrollOffset: 0,
      handleSize: 0,
      handleOffset: 0,
      maxHandleOffset: 0,
    });
  });

  it("computes visible geometry when content overflows", () => {
    const geometry = computeVerticalScrollbarGeometry({
      viewportSize: 500,
      contentSize: 2000,
      offset: 375,
      minHandleSize: 36,
    });

    expect(geometry).toEqual({
      isVisible: true,
      maxScrollOffset: 1500,
      handleSize: 125,
      handleOffset: 93.75,
      maxHandleOffset: 375,
    });
  });

  it("clamps handle size to min and offset to bounds", () => {
    const geometry = computeVerticalScrollbarGeometry({
      viewportSize: 100,
      contentSize: 10000,
      offset: 99999,
      minHandleSize: 24,
    });

    expect(geometry).toEqual({
      isVisible: true,
      maxScrollOffset: 9900,
      handleSize: 24,
      handleOffset: 76,
      maxHandleOffset: 76,
    });
  });
});

describe("computeScrollOffsetFromDragDelta", () => {
  it("maps drag distance proportionally to scroll offset", () => {
    const nextOffset = computeScrollOffsetFromDragDelta({
      startOffset: 250,
      dragDelta: 50,
      maxScrollOffset: 1000,
      maxHandleOffset: 200,
    });

    expect(nextOffset).toBe(500);
  });

  it("clamps to scroll bounds", () => {
    const nextOffset = computeScrollOffsetFromDragDelta({
      startOffset: 900,
      dragDelta: 1000,
      maxScrollOffset: 1000,
      maxHandleOffset: 200,
    });

    expect(nextOffset).toBe(1000);
  });
});
