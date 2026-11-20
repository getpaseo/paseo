import { getIsElectronRuntime } from "@/constants/layout";
import { isNative } from "@/constants/platform";

/**
 * VS Code-style titlebar drag region for Electron.
 *
 * Copied from VS Code at commit daa0a70:
 *   - titlebarPart.ts:463-464  → prepend(container, $('div.titlebar-drag-region'))
 *   - titlebarpart.css:57-64   → position: absolute, full size, -webkit-app-region: drag
 *   - titlebarpart.css:249-260 → top-edge resizer, no-drag, 4px
 *
 * VS Code's drag region is a static DOM element — no z-index, no pointer-events,
 * no state, no event listeners. Interactive elements get no-drag from their own
 * CSS (global backstop in index.html). The drag region never re-renders.
 *
 * The resizer is Windows/Linux only (titlebarpart.css:249 scopes to .windows/.linux).
 * On macOS, Electron handles edge resize natively.
 */

/**
 * Marks a scroll viewport as window content: it and its descendants emit no window
 * regions, because Electron does not clip app-region rects to scroll viewports.
 * See the `[data-window-content]` rule in public/index.html.
 */
export const WINDOW_CONTENT_DATASET = { "window-content": "" };

/** Reserves a clickable area for a control mounted outside the titlebar rail. */
export const WINDOW_NO_DRAG_DATASET = { "window-no-drag": "" };

export const titlebarDragSurfaceStyle: React.CSSProperties = {
  cursor: "default",
  // @ts-expect-error — WebkitAppRegion is not in CSSProperties
  WebkitAppRegion: "drag",
};

const DRAG_OVERLAY_STYLE: React.CSSProperties = {
  ...titlebarDragSurfaceStyle,
  top: 0,
  left: 0,
  display: "block",
  position: "absolute",
  width: "100%",
  height: "100%",
};

const TOP_RESIZER_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  width: "100%",
  height: 4,
  // @ts-expect-error — WebkitAppRegion is not in CSSProperties
  WebkitAppRegion: "no-drag",
};

/**
 * Static drag overlay and top-edge resizer. Returns null on non-Electron.
 * Place as FIRST child of any positioned container that should be draggable.
 */
export function TitlebarDragRegion() {
  if (isNative || !getIsElectronRuntime()) {
    return null;
  }

  return (
    <>
      {/* Drag overlay — VS Code .titlebar-drag-region (titlebarpart.css:57-64) */}
      <div style={DRAG_OVERLAY_STYLE} />
      {/* Top-edge resizer — VS Code .resizer (titlebarpart.css:249-256) */}
      <div style={TOP_RESIZER_STYLE} />
    </>
  );
}
