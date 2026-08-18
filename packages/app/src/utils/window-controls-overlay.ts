export interface WindowControlsOverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowControlsOverlayInsets {
  leftWidth: number;
  rightWidth: number;
  height: number;
}

export type WindowControlsOverlayMeasurement =
  | { visible: false }
  | { visible: true; insets: WindowControlsOverlayInsets };

/**
 * Insets the window controls occupy, derived from the titlebar strip Chromium leaves to the
 * app: whatever sits left and right of that strip belongs to the controls.
 *
 * Returns null for a rect that cannot describe where the controls are, so the caller keeps the
 * fallback constants instead of reserving nothing while the controls are still drawn.
 */
export function resolveWindowControlsOverlayInsets(input: {
  titlebarAreaRect: WindowControlsOverlayRect;
  viewportWidth: number;
}): WindowControlsOverlayInsets | null {
  const { titlebarAreaRect, viewportWidth } = input;
  if (
    !titlebarAreaRect ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(titlebarAreaRect.x) ||
    !Number.isFinite(titlebarAreaRect.y) ||
    !Number.isFinite(titlebarAreaRect.width) ||
    !Number.isFinite(titlebarAreaRect.height)
  ) {
    return null;
  }

  if (viewportWidth <= 0 || titlebarAreaRect.width < 0) {
    return null;
  }

  // A strip starting off-screen, or reaching past its window, is a read taken mid-resize.
  if (titlebarAreaRect.x < 0 || titlebarAreaRect.x + titlebarAreaRect.width > viewportWidth) {
    return null;
  }

  const height = Math.round(titlebarAreaRect.height);
  if (height <= 0) {
    return null;
  }

  const leftWidth = Math.round(titlebarAreaRect.x);
  const rightWidth = Math.round(viewportWidth - (titlebarAreaRect.x + titlebarAreaRect.width));

  // The strip spans the whole window, so it says nothing about where the controls are. Reserving
  // zero here would drop the clearance entirely while the controls stay on screen.
  if (leftWidth <= 0 && rightWidth <= 0) {
    return null;
  }

  return {
    leftWidth: Math.max(0, leftWidth),
    rightWidth: Math.max(0, rightWidth),
    height,
  };
}
