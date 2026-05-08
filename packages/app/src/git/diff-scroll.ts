interface AnchorVisibilityInput {
  headerOffset: number;
  headerHeight: number;
  viewportOffset: number;
  viewportHeight: number;
  edgeThreshold?: number;
}

export function shouldAnchorHeaderBeforeCollapse({
  headerOffset,
  headerHeight,
  viewportOffset,
  viewportHeight,
  edgeThreshold = 1,
}: AnchorVisibilityInput): boolean {
  if (
    !Number.isFinite(headerOffset) ||
    !Number.isFinite(headerHeight) ||
    !Number.isFinite(viewportOffset) ||
    !Number.isFinite(viewportHeight) ||
    viewportHeight <= 0
  ) {
    // Preserve current behavior when metrics are unavailable.
    return true;
  }

  const clampedThreshold = Math.max(0, edgeThreshold);
  const clampedHeaderHeight = Math.max(0, headerHeight);
  const headerStart = headerOffset;
  const headerEnd = headerOffset + clampedHeaderHeight;
  const viewportStart = viewportOffset + clampedThreshold;
  const viewportEnd = viewportOffset + viewportHeight - clampedThreshold;
  const headerVisible = headerEnd > viewportStart && headerStart < viewportEnd;

  return !headerVisible;
}
