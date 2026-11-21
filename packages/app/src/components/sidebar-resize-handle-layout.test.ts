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

  it("keeps a web touch grip inside the sidebar, level with the top navigation rows", () => {
    const geometry = resolveSidebarResizeHandleGeometry(false, true);

    // The sidebar clips its overflow, so a grip outside it can't be touched.
    expect(geometry.edgeOffset).toBeGreaterThanOrEqual(0);
    expect(geometry.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    // Not centred, where it would cover a row's menu button.
    expect(geometry.top).toBe(48);
  });

  it("centres the native touch grip", () => {
    expect(resolveSidebarResizeHandleGeometry(false).top).toBeNull();
  });

  it("straddles the border for a fine pointer", () => {
    const geometry = resolveSidebarResizeHandleGeometry(true);

    expect(geometry.edgeOffset).toBe(-geometry.width / 2);
    expect(geometry.height).toBeNull();
  });
});
