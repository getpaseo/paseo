/**
 * Height metrics for the queued-message list.
 *
 * The queue used to grow without bound, so a long queue pushed the composer off
 * screen. It is capped instead, and the cap is derived from the row box here
 * rather than written as a pixel literal in the stylesheet: changing the action
 * button size or the row padding then keeps showing the same number of items
 * instead of silently showing a fraction more or fewer.
 */

/** Queued rows visible before the list scrolls. */
export const QUEUE_VISIBLE_ITEMS = 5;

/** Square edit/send buttons, which set the row's minimum content height. */
export const QUEUE_ACTION_BUTTON_SIZE = 32;

export interface QueueTrackMetrics {
  /** Vertical padding applied to each row, and the gap between rows. */
  spacing: number;
  /** Row border width, counted on both edges. */
  borderWidth: number;
  /** Defaults to QUEUE_VISIBLE_ITEMS. */
  visibleItems?: number;
}

export function queueTrackMaxHeight({
  spacing,
  borderWidth,
  visibleItems = QUEUE_VISIBLE_ITEMS,
}: QueueTrackMetrics): number {
  if (visibleItems <= 0) return 0;
  const rowHeight = QUEUE_ACTION_BUTTON_SIZE + spacing * 2 + borderWidth * 2;
  return rowHeight * visibleItems + spacing * (visibleItems - 1);
}
