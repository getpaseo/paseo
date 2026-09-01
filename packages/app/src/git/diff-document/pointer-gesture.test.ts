import { describe, expect, it } from "vitest";
import { hasPointerDragStarted } from "./pointer-gesture";

describe("diff pointer gesture", () => {
  it("classifies pointer movement as a drag without requiring a character change", () => {
    expect(
      hasPointerDragStarted({
        startX: 10,
        startY: 10,
        x: 15,
        y: 10,
        alreadyDragging: false,
      }),
    ).toBe(true);
  });

  it("keeps a gesture classified as a drag after it crosses the threshold", () => {
    expect(
      hasPointerDragStarted({
        startX: 10,
        startY: 10,
        x: 10,
        y: 10,
        alreadyDragging: true,
      }),
    ).toBe(true);
  });
});
