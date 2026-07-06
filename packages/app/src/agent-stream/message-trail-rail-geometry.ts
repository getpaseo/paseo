import type { TrailAnchorSnapshot } from "./message-trail-anchor";

// Pure, DOM-free geometry/decision helpers for the message-trail rail. Extracted from
// message-trail-rail.web.tsx so they can be unit-tested without pulling in DOM/React (a
// `.web.tsx` module can't be imported by a pure test). Behavior here must stay byte-identical
// to the original inline code — same numbers, same clamps, same tie-breaks.
//
// These are plain literals rather than theme tokens: they feed raw DOM style/geometry math
// (imperative writes, CSS px), not a React `style` prop, which is exactly the case
// docs/unistyles.md's "hard-coded constants for genuinely static values" calls out — the
// values don't need to be theme-reactive, they need to be numbers JS can do arithmetic on.
export const RAIL_WIDTH = 20;
export const TICK_HEIGHT = 2;
export const TICK_MAX_WIDTH = 20;
// Tick spacing is dynamic: at the default when there's room, compressed toward the minimum
// so hundreds of ticks still fit the available height (a minimap) rather than overflowing.
// The magnification is the "accordion" that expands a compressed region on hover.
export const DEFAULT_TICK_SPACING = 10; // center-to-center when there's room
export const MIN_TICK_SPACING = 3; // floor when compressing many ticks to fit
// Never let the rail region's left edge get closer than this to the pane edge.
export const RAIL_EDGE_MIN = 3;
// Small bias toward the pane edge so the rail reads a touch left of the exact midpoint.
export const RAIL_NUDGE_LEFT = 6;
// Minimum breathing room between the rail's right edge (where a fully-magnified, center-
// anchored tick reaches — it can grow up to TICK_MAX_WIDTH === RAIL_WIDTH) and the content's
// real left edge.
export const MIN_GAP_TO_CONTENT = 6;
// The rail needs at least this much measured content inset to fit without overlapping.
export const MIN_CONTENT_INSET_FOR_RAIL = RAIL_WIDTH + MIN_GAP_TO_CONTENT + RAIL_EDGE_MIN;
// The rail needs enough vertical room for the tooltip to clear both above and below the
// focused tick — below this it reads as cramped regardless of how many ticks fit.
const TOOLTIP_BOTTOM_CLEARANCE = 64;
export const MIN_PANE_HEIGHT_FOR_RAIL = TOOLTIP_BOTTOM_CLEARANCE * 2;

// Opacity states, quietest to loudest.
export const OPACITY_REST = 0.2;
export const OPACITY_CURRENT = 0.9;
export const OPACITY_FOCUS = 1;

// Gaussian magnification. Sigma is a tight fraction of the (dynamic) tick spacing so the
// highlight focuses on the single hovered tick — a wider sigma lights up every neighbour,
// which with only a handful of ticks reads as "all of them turned white". Scaling with the
// spacing keeps the focus window ~half a tick wide even when the ticks are compressed.
export const SIGMA_FRACTION = 0.5;
// Below this weight the tick is effectively unmagnified; skip the write.
export const MAGNIFY_ACTIVATION = 0.02;

// Center the (center-anchored) tick column on the midpoint of the measured content inset —
// halfway between the pane's left edge and the real left edge of the chat content, biased a
// touch toward the pane edge. Hard-clamped so the rail's right edge never crosses into the
// content even if `contentInsetLeft` is smaller than expected.
export function resolveRailLeft(contentInsetLeft: number): number {
  const desired = contentInsetLeft / 2 - RAIL_WIDTH / 2 - RAIL_NUDGE_LEFT;
  const maxLeft = contentInsetLeft - RAIL_WIDTH - MIN_GAP_TO_CONTENT;
  return Math.max(RAIL_EDGE_MIN, Math.min(desired, maxLeft));
}

// Compress the tick spacing so `count` ticks fit within `availableHeight` (a minimap),
// down to a readable floor — falling back to the default when there's plenty of room.
export function resolveTickSpacing(count: number, availableHeight: number): number {
  if (count <= 1 || availableHeight <= 0) {
    return DEFAULT_TICK_SPACING;
  }
  const fitSpacing = (availableHeight - TICK_HEIGHT) / (count - 1);
  return Math.min(DEFAULT_TICK_SPACING, Math.max(MIN_TICK_SPACING, fitSpacing));
}

export function twoSigmaSqFor(spacing: number): number {
  const sigma = SIGMA_FRACTION * spacing;
  return 2 * sigma * sigma;
}

// Gaussian falloff for a tick at `distance` px from the pointer, given the precomputed
// 2σ² denominator. 1 at the pointer, decaying toward 0 as distance grows.
export function gaussianWeight(distance: number, twoSigmaSq: number): number {
  return Math.exp(-(distance * distance) / twoSigmaSq);
}

// Base opacity a tick rests at for a given anchor snapshot, before pointer focus. Only the
// single "current" (active-reading-position) tick is lit at rest — every other tick,
// including ones merely scrolled into view, stays at the same quiet resting opacity so
// there's exactly one lit tick when the pointer isn't hovering.
export function anchorOpacityFor(itemId: string, snapshot: TrailAnchorSnapshot): number {
  return snapshot.currentId === itemId ? OPACITY_CURRENT : OPACITY_REST;
}

// The rail needs both enough horizontal content inset and enough pane height to render
// without overlapping the chat content; below either threshold the floating TOC is shown
// instead.
export function railFits(contentInsetLeft: number, paneHeight: number): boolean {
  return contentInsetLeft >= MIN_CONTENT_INSET_FOR_RAIL && paneHeight >= MIN_PANE_HEIGHT_FOR_RAIL;
}

// Map a pointer Y (relative to the tick column) to the index of the nearest tick center.
// Tick centers are `index * spacing + TICK_HEIGHT / 2`. Strict `<` comparison means ties
// resolve to the earlier tick. Returns -1 for an empty set (matches applyMagnification's
// `nearestIndex = -1` default); callers with at least one tick always get a valid index.
export function resolveNearestTickIndex(pointerY: number, count: number, spacing: number): number {
  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < count; index += 1) {
    const center = index * spacing + TICK_HEIGHT / 2;
    const distance = Math.abs(pointerY - center);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}
