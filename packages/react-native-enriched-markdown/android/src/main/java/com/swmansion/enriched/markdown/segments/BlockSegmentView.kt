package com.swmansion.enriched.markdown.segments

/**
 * Interface for block-level segment views that declare their own margins
 * for layout by EnrichedMarkdown.
 */
interface BlockSegmentView {
  val segmentMarginTop: Int get() = 0
  val segmentMarginBottom: Int get() = 0
}
