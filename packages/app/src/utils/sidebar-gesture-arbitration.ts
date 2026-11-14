interface Point {
  x: number;
  y: number;
}

const SCROLL_SLOP_PX = 6;
const SWIPE_SLOP_PX = 8;
const CANCEL_SLOP_PX = 10;
const DIRECTIONAL_DOMINANCE_RATIO = 1.5;

/**
 * Whether a row press moved far enough to be a scroll, a swipe, or a drift rather than a tap.
 * A clearly vertical or horizontal move counts sooner than a diagonal one.
 */
export function didPressMove(input: { startPoint: Point; currentPoint: Point }): boolean {
  const absDx = Math.abs(input.currentPoint.x - input.startPoint.x);
  const absDy = Math.abs(input.currentPoint.y - input.startPoint.y);
  if (absDy >= absDx * DIRECTIONAL_DOMINANCE_RATIO && absDy > SCROLL_SLOP_PX) {
    return true;
  }
  if (absDx >= absDy * DIRECTIONAL_DOMINANCE_RATIO && absDx > SWIPE_SLOP_PX) {
    return true;
  }
  return Math.sqrt(absDx * absDx + absDy * absDy) > CANCEL_SLOP_PX;
}
