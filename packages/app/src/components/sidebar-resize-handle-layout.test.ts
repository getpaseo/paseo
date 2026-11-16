import { describe, expect, it } from "vitest";
import { resolveSidebarResizeHandleGeometry } from "./sidebar-resize-handle-layout";

const MIN_TOUCH_TARGET = 24;

describe("resolveSidebarResizeHandleGeometry", () => {
  it("keeps the touch hit area inside the sidebar so native hit-testing reaches it", () => {
    const geometry = resolveSidebarResizeHandleGeometry(false);

    expect(geometry.edgeOffset).toBeGreaterThanOrEqual(0);
    expect(geometry.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    expect(geometry.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });

  it("keeps the fine pointer hit area inside the sidebar along the full border", () => {
    const geometry = resolveSidebarResizeHandleGeometry(true);

    expect(geometry.edgeOffset).toBeGreaterThanOrEqual(0);
    expect(geometry.height).toBeNull();
  });
});
