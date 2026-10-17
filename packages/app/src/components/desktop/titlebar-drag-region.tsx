import { getIsElectronRuntime } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { toggleDesktopMaximize } from "@/desktop/electron/window";
import { isElectronRuntimeMac } from "@/desktop/host";

type AppRegionStyle = React.CSSProperties & {
  WebkitAppRegion?: "drag" | "no-drag";
};

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
 * CSS (global backstop in index.html). The drag region never re-renders except
 * for the native titlebar double-click handler below.
 *
 * The resizer is Windows/Linux only (titlebarpart.css:249 scopes to .windows/.linux).
 * On macOS, Electron handles edge resize natively.
 */

export const titlebarDragSurfaceStyle: AppRegionStyle = {
  cursor: "default",
  WebkitAppRegion: "drag",
};

const DRAG_OVERLAY_STYLE: AppRegionStyle = {
  ...titlebarDragSurfaceStyle,
  top: 0,
  left: 0,
  display: "block",
  position: "absolute",
  width: "100%",
  height: "100%",
};

const TOP_RESIZER_STYLE: AppRegionStyle = {
  position: "absolute",
  top: 0,
  width: "100%",
  height: 4,
  WebkitAppRegion: "no-drag",
};

// Electron does not dispatch DOM mouse events from an app-region: drag node.
// Keep the native drag surface intact and reserve only the strip below the
// auto-hidden macOS menu-bar area for the DOM double-click fallback.
const DOUBLE_CLICK_FALLBACK_STYLE: AppRegionStyle = {
  position: "absolute",
  top: 28,
  left: 0,
  display: "block",
  width: "100%",
  height: 8,
  WebkitAppRegion: "no-drag",
};

function handleTitlebarDoubleClick(): void {
  if (!isElectronRuntimeMac()) return;
  void toggleDesktopMaximize();
}

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
      {/*
       * Drag overlay — VS Code .titlebar-drag-region (titlebarpart.css:57-64).
       * Electron handles the native double-click in most of this surface.
       */}
      <div data-testid="titlebar-drag-region" style={DRAG_OVERLAY_STYLE} />
      {/* Top-edge resizer — VS Code .resizer (titlebarpart.css:249-256) */}
      <div
        data-testid="titlebar-top-resizer"
        onDoubleClick={handleTitlebarDoubleClick}
        style={TOP_RESIZER_STYLE}
      />
      {isElectronRuntimeMac() ? (
        /*
         * Electron does not send DOM events from app-region: drag. This narrow
         * no-drag strip remains below the auto-hidden macOS menu-bar area, so the
         * fallback can receive the double-click in a maximized window. Later
         * interactive siblings stay above it and keep their own behavior.
         */
        <div
          data-testid="titlebar-double-click-fallback"
          onDoubleClick={handleTitlebarDoubleClick}
          style={DOUBLE_CLICK_FALLBACK_STYLE}
        />
      ) : null}
    </>
  );
}
