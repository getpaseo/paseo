// Pure layout math for the draggable separator between the diff content above
// and the commits drawer pinned at the bottom (see docs/floating-panels.md
// sibling layout).

/** Smallest the commits viewport may shrink to while staying usable. */
export const COMMITS_SECTION_MIN_HEIGHT = 96;

/** Hard ceiling applied when the container height cannot be measured. */
export const COMMITS_SECTION_MAX_HEIGHT = 600;

/**
 * Space we always reserve for the diff above the commits drawer so dragging the
 * separator all the way up never collapses the diff out of view.
 */
export const COMMITS_SECTION_DIFF_RESERVE = 160;

export interface CommitsSectionHeightBounds {
  min: number;
  max: number;
}

/**
 * Derive the clamp bounds for the commits section height. When the container
 * height is known we cap the section so at least {@link COMMITS_SECTION_DIFF_RESERVE}
 * pixels remain for the diff; otherwise we fall back to a static ceiling.
 */
export function commitsSectionHeightBounds(containerHeight: number): CommitsSectionHeightBounds {
  const reserved = containerHeight - COMMITS_SECTION_DIFF_RESERVE;
  const measuredMax =
    containerHeight > 0
      ? Math.min(COMMITS_SECTION_MAX_HEIGHT, reserved)
      : COMMITS_SECTION_MAX_HEIGHT;
  const max = Math.max(COMMITS_SECTION_MIN_HEIGHT, measuredMax);
  return { min: COMMITS_SECTION_MIN_HEIGHT, max };
}

/** Clamp a candidate commits-section height into the given bounds. */
export function clampCommitsSectionHeight(
  height: number,
  bounds: CommitsSectionHeightBounds,
): number {
  if (Number.isNaN(height)) {
    return bounds.min;
  }
  return Math.min(bounds.max, Math.max(bounds.min, height));
}
