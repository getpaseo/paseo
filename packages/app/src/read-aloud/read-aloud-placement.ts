/**
 * Where the read-aloud bubble goes, given the selection's endpoints and the box
 * it is actually visible in.
 *
 * Pure arithmetic, no DOM: the geometry is read in
 * `use-selection-anchor.web.ts` and the widths are owned by
 * `read-aloud-selection-bubble.web.tsx`, so the decision in between is testable
 * on its own.
 */

/** A viewport-space box. Structurally a subset of `DOMRect`. */
export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PlacementInput {
  /** Caret rect at the selection's start, or null once its nodes detached. */
  firstRect: AnchorRect | null;
  /** Caret rect at the selection's end, or null once its nodes detached. */
  lastRect: AnchorRect | null;
  /** Window intersected with every clipping ancestor — the real visible area. */
  visibleBox: AnchorRect;
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /**
   * The selection is not in view. Idle bubbles hide; a speaking bubble stays
   * parked at the nearest edge, because it is the only stop control.
   */
  isOffscreen: boolean;
}

/** Gap between the selection edge and the bubble. */
export const ANCHOR_OFFSET = 8;
/** Breathing room between the bubble and the edge of the visible box. */
export const BOX_PADDING = 8;

export function intersectRects(a: AnchorRect, b: AnchorRect): AnchorRect {
  const top = Math.max(a.top, b.top);
  const left = Math.max(a.left, b.left);
  // Disjoint boxes would invert; collapse to a degenerate box at the overlap
  // edge so downstream math never sees `bottom < top`.
  return {
    top,
    left,
    bottom: Math.max(top, Math.min(a.bottom, b.bottom)),
    right: Math.max(left, Math.min(a.right, b.right)),
  };
}

/**
 * Vertical-only: a rect is "in view" when any part of its line band overlaps
 * the box. Horizontal overlap does not decide which endpoint to anchor to —
 * the final clamp handles the x-axis.
 */
function isVisible(rect: AnchorRect, box: AnchorRect): boolean {
  return rect.bottom > box.top && rect.top < box.bottom;
}

/**
 * Clamp one axis into `[min, max]`.
 *
 * A box shorter than the bubble plus its padding has no valid slot, and the
 * naive `max(pad, min(limit, value))` inverts there — the `max` wins and pushes
 * the bubble out past the far edge. Centring is the sane degenerate answer.
 */
function clampIntoRange(value: number, size: number, min: number, max: number): number {
  const lo = min + BOX_PADDING;
  const hi = max - size - BOX_PADDING;
  if (hi < lo) {
    return (min + max) / 2 - size / 2;
  }
  return Math.min(Math.max(value, lo), hi);
}

function centerXOf(rect: AnchorRect): number {
  return (rect.left + rect.right) / 2;
}

interface AnchorChoice {
  centerX: number;
  top: number;
  isOffscreen: boolean;
}

/** Above the rect, flipped below when there is no room above. */
function above(rect: AnchorRect, box: AnchorRect, height: number): number {
  const top = rect.top - height - ANCHOR_OFFSET;
  return top < box.top + BOX_PADDING ? rect.bottom + ANCHOR_OFFSET : top;
}

/** Below the rect, flipped above when there is no room below. */
function below(rect: AnchorRect, box: AnchorRect, height: number): number {
  const top = rect.bottom + ANCHOR_OFFSET;
  return top + height > box.bottom - BOX_PADDING ? rect.top - height - ANCHOR_OFFSET : top;
}

function pickAnchor(
  firstRect: AnchorRect | null,
  lastRect: AnchorRect | null,
  box: AnchorRect,
  height: number,
): AnchorChoice {
  // Start endpoint in view — including "both visible" and "end clipped" — keeps
  // the original above-the-start placement.
  if (firstRect && isVisible(firstRect, box)) {
    return {
      centerX: centerXOf(firstRect),
      top: above(firstRect, box, height),
      isOffscreen: false,
    };
  }
  // Start scrolled out, end still in view: anchor below what the user can see.
  if (lastRect && isVisible(lastRect, box)) {
    return { centerX: centerXOf(lastRect), top: below(lastRect, box, height), isOffscreen: false };
  }

  // Neither endpoint is in view. A selection taller than the box still has its
  // middle on screen, so anchor to the box itself rather than scanning for a
  // mid-selection rect: stable under scroll, and O(1) exactly when the
  // selection is largest. Accepted imperfection — a selection with a big
  // unselected gap in the middle can put the bubble over unselected content.
  const spansBox =
    firstRect !== null &&
    lastRect !== null &&
    firstRect.top <= box.top &&
    lastRect.bottom >= box.bottom;
  if (spansBox) {
    return {
      centerX: centerXOf(box),
      top: box.bottom - height - ANCHOR_OFFSET,
      isOffscreen: false,
    };
  }

  // Entirely out of view: park at the edge it went out through.
  const scrolledAbove = lastRect !== null && lastRect.bottom <= box.top;
  const parkRect = scrolledAbove ? lastRect : (firstRect ?? lastRect);
  return {
    centerX: parkRect ? centerXOf(parkRect) : centerXOf(box),
    top: scrolledAbove ? box.top + BOX_PADDING : box.bottom - height - BOX_PADDING,
    isOffscreen: true,
  };
}

export function decidePlacement({
  firstRect,
  lastRect,
  visibleBox,
  width,
  height,
}: PlacementInput): Placement {
  const anchor = pickAnchor(firstRect, lastRect, visibleBox, height);
  return {
    left: clampIntoRange(anchor.centerX - width / 2, width, visibleBox.left, visibleBox.right),
    top: clampIntoRange(anchor.top, height, visibleBox.top, visibleBox.bottom),
    isOffscreen: anchor.isOffscreen,
  };
}
