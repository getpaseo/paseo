/**
 * The "safe triangle" that keeps a submenu open while the pointer travels
 * diagonally towards it.
 *
 * Moving straight from the parent row to the submenu can pass over a sibling
 * row, and a naive hover handler would then close the submenu the pointer is on
 * its way to. The classic fix is to keep it open while the pointer stays inside
 * the triangle formed by the pointer's position when the submenu opened and the
 * submenu's near edge. This is geometry over plain numbers, so it is kept out of
 * the component and unit-tested on its own.
 *
 * @format
 */

import type { Point, Rect, SubmenuSide } from './placement';

export interface SafeTriangle {
  /** The pointer position when the submenu opened. */
  origin: Point;
  /** The two corners of the submenu's edge facing the parent menu. */
  nearTop: Point;
  nearBottom: Point;
}

export function safeTriangleFor(
  origin: Point,
  submenuRect: Rect,
  side: SubmenuSide,
): SafeTriangle {
  // A right-opening submenu is entered through its left edge, and the other way
  // round, so the near edge is the one closest to the parent row.
  const x =
    side === 'right' ? submenuRect.x : submenuRect.x + submenuRect.width;
  return {
    origin,
    nearTop: { x, y: submenuRect.y },
    nearBottom: { x, y: submenuRect.y + submenuRect.height },
  };
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * Whether `point` lies inside the triangle, edges included.
 *
 * The three cross products are compared by sign. A degenerate triangle (the
 * pointer is vertically aligned with the near edge) has no area, so only points
 * on that line count; that is the correct reading of a zero-width triangle and
 * avoids a special case that would keep the submenu open anywhere.
 */
export function isInSafeTriangle(
  point: Point,
  triangle: SafeTriangle,
): boolean {
  const { origin, nearTop, nearBottom } = triangle;
  const a = cross(origin, nearTop, point);
  const b = cross(nearTop, nearBottom, point);
  const c = cross(nearBottom, origin, point);
  const hasNegative = a < 0 || b < 0 || c < 0;
  const hasPositive = a > 0 || b > 0 || c > 0;
  return !(hasNegative && hasPositive);
}
