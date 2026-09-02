import { describe, expect, it } from "vitest";
import { isPinnedDragHandleVisible } from "./sidebar-pinned-drag-handle";

describe("isPinnedDragHandleVisible", () => {
  it("stays reserved-but-hidden until hover on desktop", () => {
    expect(
      isPinnedDragHandleVisible({ hovered: false, dragging: false, alwaysVisible: false }),
    ).toBe(false);
  });

  it("appears on hover or while dragging", () => {
    expect(
      isPinnedDragHandleVisible({ hovered: true, dragging: false, alwaysVisible: false }),
    ).toBe(true);
    expect(
      isPinnedDragHandleVisible({ hovered: false, dragging: true, alwaysVisible: false }),
    ).toBe(true);
  });

  it("stays visible on touch so the affordance is not hover-only", () => {
    expect(
      isPinnedDragHandleVisible({ hovered: false, dragging: false, alwaysVisible: true }),
    ).toBe(true);
  });
});
