package com.swmansion.enriched.markdown.segments

import android.view.View

/**
 * Per-kind view work seam used by ContainerNodeView to build and reconcile
 * child views from RenderedSegment data. The root document and every
 * BlockquoteContainerView supply their own implementation so the reconcile /
 * layout loop can stay identical while the actual child view construction
 * (callbacks, styling, accessibility) varies per host.
 */
interface SegmentViewFactory {
  fun matchesKind(
    view: View,
    segment: RenderedSegment,
  ): Boolean

  fun createView(segment: RenderedSegment): View

  fun updateView(
    view: View,
    segment: RenderedSegment,
  )

  fun animateNewView(
    view: View,
    segment: RenderedSegment,
  )
}
