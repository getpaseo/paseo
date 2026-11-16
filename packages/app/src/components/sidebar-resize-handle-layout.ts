/**
 * Geometry for the sidebar resize handle.
 *
 * Both variants sit fully inside the sidebar, because hit-testing does not
 * reliably reach a strip that hangs past the border. On web, the docked left
 * sidebar clips its content with `overflow: hidden`, and the workspace that
 * follows it in the DOM paints over anything that escapes. On native, iOS
 * `hitTest:` returns nil for points outside a view's bounds and Gesture
 * Handler's Android traversal only recurses into children whose ancestors
 * contain the point.
 *
 * A mouse can grab a thin strip along the border. A finger needs a target
 * sized for a thumb.
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
  /** Distance from the sidebar edge to the near side of the hit area. */
  edgeOffset: number;
  width: number;
  /** `null` stretches the hit area to the sidebar's full height. */
  height: number | null;
}

export function resolveSidebarResizeHandleGeometry(
  finePointer: boolean,
): SidebarResizeHandleGeometry {
  if (finePointer) {
    return {
      edgeOffset: 0,
      width: POINTER_HANDLE_WIDTH,
      height: null,
    };
  }
  return {
    edgeOffset: 0,
    width: TOUCH_HANDLE_WIDTH,
    height: TOUCH_HANDLE_HEIGHT,
  };
}
