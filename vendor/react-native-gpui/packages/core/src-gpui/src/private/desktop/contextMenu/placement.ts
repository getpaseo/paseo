/**
 * Where a menu level goes inside a window.
 *
 * The custom menu is drawn inside the window, so it cannot extend past the
 * window's edges the way a native popup can. Every position is therefore
 * derived, then flipped when the preferred side would overflow, then clamped.
 * The functions here are pure and take plain numbers, which is what makes the
 * edge cases (a menu taller than the window, a margin wider than the window)
 * cheap to test.
 *
 * @format
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

/** The gap kept between a menu and the window edge, unless a caller says otherwise. */
export const DEFAULT_MENU_MARGIN = 4;

export interface RootMenuPlacement {
  /** The pointer position or the trigger's corner, in window coordinates. */
  anchor: Point;
  menuSize: Size;
  windowSize: Size;
  /** The minimum gap to each window edge. */
  margin?: number;
}

export interface SubmenuPlacement {
  /** The parent row's rectangle, in window coordinates. */
  rowRect: Rect;
  menuSize: Size;
  windowSize: Size;
  margin?: number;
}

/**
 * Keeps one axis inside `[margin, window - margin - size]`.
 *
 * When the menu is larger than the space between the margins, the upper bound
 * falls below the margin; using the margin then is what keeps the result
 * non-negative and aligned to the near edge, rather than mirroring the overflow
 * to the other side or returning a negative coordinate.
 */
function clampAxis(
  value: number,
  size: number,
  windowSize: number,
  margin: number,
): number {
  const limit = windowSize - margin - size;
  if (!Number.isFinite(limit) || limit < margin) {
    return margin;
  }
  if (!Number.isFinite(value)) {
    return margin;
  }
  return Math.min(Math.max(value, margin), limit);
}

function normaliseMargin(margin: number | undefined): number {
  if (margin == null || !Number.isFinite(margin)) {
    return DEFAULT_MENU_MARGIN;
  }
  return Math.max(0, margin);
}

/**
 * A root menu sits with its top-left at the anchor. It flips left when it would
 * pass the right edge and flips up when it would pass the bottom edge, which is
 * what a context menu near the bottom-right corner needs. The flip is applied
 * before the clamp so a flipped menu stays flush with the anchor instead of
 * drifting away from the pointer.
 */
export function placeRootMenu({
  anchor,
  menuSize,
  windowSize,
  margin,
}: RootMenuPlacement): Point {
  const gap = normaliseMargin(margin);
  const rightLimit = windowSize.width - gap;
  const bottomLimit = windowSize.height - gap;
  const x =
    anchor.x + menuSize.width > rightLimit
      ? anchor.x - menuSize.width
      : anchor.x;
  const y =
    anchor.y + menuSize.height > bottomLimit
      ? anchor.y - menuSize.height
      : anchor.y;
  return {
    x: clampAxis(x, menuSize.width, windowSize.width, gap),
    y: clampAxis(y, menuSize.height, windowSize.height, gap),
  };
}

export type SubmenuSide = 'right' | 'left';

export interface SubmenuPosition extends Point {
  side: SubmenuSide;
}

/**
 * A submenu opens to the right of its row, top-aligned with it. With no room on
 * the right it opens to the left instead, which is the only side that can work
 * near the right edge of the window; the vertical position is clamped so a
 * submenu near the bottom does not need flipping.
 *
 * The side is reported because the safe triangle has to know which edge of the
 * submenu is the near one.
 */
export function placeSubmenu({
  rowRect,
  menuSize,
  windowSize,
  margin,
}: SubmenuPlacement): SubmenuPosition {
  const gap = normaliseMargin(margin);
  const rightLimit = windowSize.width - gap;
  const opensRight = rowRect.x + rowRect.width + menuSize.width <= rightLimit;
  const side: SubmenuSide = opensRight ? 'right' : 'left';
  const preferredX = opensRight
    ? rowRect.x + rowRect.width
    : rowRect.x - menuSize.width;
  return {
    x: clampAxis(preferredX, menuSize.width, windowSize.width, gap),
    y: clampAxis(rowRect.y, menuSize.height, windowSize.height, gap),
    side,
  };
}

/**
 * The window size as reported by a layout event, with a zero or missing size
 * treated as "not measured yet". A menu is not placed against an unmeasured
 * window: it would clamp every position to the margin and visibly jump.
 */
export function measurableSize(size: {
  width: number;
  height: number;
}): Size | null {
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    return null;
  }
  return { width: size.width, height: size.height };
}
