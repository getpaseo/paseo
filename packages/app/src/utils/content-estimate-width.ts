import { LAYOUT } from "@/styles/theme";

/**
 * The live content measure, mirrored out of the theme for non-React callers.
 *
 * Virtualized height estimation runs in plain modules that cannot read a Unistyles
 * theme, and reading the authored `LAYOUT` token at module scope would pin them to the
 * default forever. `applyAppearance` pushes the committed value here in the
 * same pass that patches the theme, and estimators read it per call.
 *
 * Cached block heights stay keyed by the width they were measured at, so entries
 * recorded under a previous measure are inert rather than wrong — they miss and get
 * evicted by the usual LRU rather than needing an explicit flush.
 */
let contentEstimateWidth: number = LAYOUT.maxContentWidth;

export function getContentEstimateWidth(): number {
  return contentEstimateWidth;
}

export function setContentEstimateWidth(width: number): void {
  if (!Number.isFinite(width) || width <= 0) {
    return;
  }
  contentEstimateWidth = Math.round(width);
}
