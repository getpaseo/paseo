import React from "react";
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
 * CSS (scoped backstop in index.html). The drag region never re-renders.
 *
 * The resizer is Windows/Linux only (titlebarpart.css:249 scopes to .windows/.linux).
 * On macOS, Electron handles edge resize natively.
 *
 * The overlay carries `data-paseo-drag-overlay`. Chromium collects draggable
 * regions from UNCLIPPED layout bounds, so content scrolled inside a list (chat
 * history, logs) still reports element rects through the titlebar strip — any
 * global `no-drag` backstop would let that content punch the drag region full of
 * holes and make the titlebar undraggable. index.html therefore applies the
 * no-drag backstop only inside `:has(> [data-paseo-drag-overlay])` surfaces and
 * `[data-paseo-no-drag-scope]` floating layers.
 */

/** Marks the container that directly hosts a {@link TitlebarDragRegion} overlay. */
export const TITLEBAR_DRAG_OVERLAY_ATTRIBUTE = "data-paseo-drag-overlay";

/** Marks floating layers (portals, window controls) that can overlap a drag overlay. */
export const NO_DRAG_SCOPE_ATTRIBUTE = "data-paseo-no-drag-scope";

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
      <div {...{ [TITLEBAR_DRAG_OVERLAY_ATTRIBUTE]: "true" }} style={DRAG_OVERLAY_STYLE} />
      {/* Top-edge resizer — VS Code .resizer (titlebarpart.css:249-256) */}
      <div style={TOP_RESIZER_STYLE} />
    </>
  );
}
