/**
 * Geometry for the sidebar resize handle.
 *
 * A mouse can grab a hairline, so the pointer variant straddles the sidebar
 * border — half the strip hangs outside the sidebar's own bounds, which is
 * fine because web hit-testing does not clip to the parent box.
 *
 * Native hit-testing does clip: iOS `hitTest:` returns nil for points outside a
 * view's bounds and Gesture Handler's Android traversal only recurses into
 * children whose ancestors contain the point. A strip hanging outside the
 * sidebar is dead on touch, and what remains is far too small for a finger.
 * So the touch variant sits fully inside the sidebar and is sized for a thumb.
 *
 * A touch screen on the web (an iPad in the browser) shows every row's menu button
 * at the sidebar's right edge, and a grip centred on that edge covers the menu of
 * whichever row is at mid-height. The grip can't move outside the sidebar either:
 * the sidebar clips its overflow, which in a browser also clips hit-testing. So on
 * the web the touch grip stays inside and sits level with the top navigation rows
 * (New workspace, History, Search...), which have nothing at their right edge.
 */

export const POINTER_HANDLE_WIDTH = 10;
export const TOUCH_HANDLE_WIDTH = 24;
export const TOUCH_HANDLE_HEIGHT = 88;

/**
 * A finger resting on the grip drifts before it commits. Requiring horizontal
 * intent before the pan activates, and failing it once the drift is mostly
 * vertical, leaves the sidebar's own scrolling reachable through the grip.
 * A mouse press moves less than either threshold, so pointer drags are
 * unaffected.
 */
export const SIDEBAR_RESIZE_ACTIVATION_OFFSET = 6;
export const SIDEBAR_RESIZE_FAIL_OFFSET = 12;

export type SidebarResizeEdge = "left" | "right";

export interface SidebarResizeHandleGeometry {
  /**
   * Distance from the sidebar edge to the near side of the hit area. Negative
   * means the hit area overhangs the sidebar, which only touch forbids.
   */
  edgeOffset: number;
  width: number;
  /** `null` stretches the hit area to the sidebar's full height. */
  height: number | null;
  /** Distance from the sidebar's top to the hit area; `null` centres it vertically. */
  top: number | null;
}

/** The web touch grip's distance from the sidebar top: beside the top navigation rows. */
export const WEB_TOUCH_HANDLE_TOP = 48;

export function resolveSidebarResizeHandleGeometry(
  finePointer: boolean,
  web = false,
): SidebarResizeHandleGeometry {
  if (finePointer) {
    return {
      edgeOffset: -POINTER_HANDLE_WIDTH / 2,
      width: POINTER_HANDLE_WIDTH,
      height: null,
      top: null,
    };
  }
  return {
    edgeOffset: 0,
    width: TOUCH_HANDLE_WIDTH,
    height: TOUCH_HANDLE_HEIGHT,
    top: web ? WEB_TOUCH_HANDLE_TOP : null,
  };
}
