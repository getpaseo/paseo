package com.swmansion.enriched.markdown.spans

import android.graphics.Canvas
import android.graphics.Paint
import android.text.Layout
import android.text.Spanned
import android.text.style.LeadingMarginSpan

// Draws a list marker on a line owned by another block (code block, nested
// sublist) without contributing any margin of its own.
class ListMarkerAnchorSpan(
  internal val marker: BaseListSpan,
) : LeadingMarginSpan {
  override fun getLeadingMargin(first: Boolean): Int = 0

  override fun drawLeadingMargin(
    c: Canvas,
    p: Paint,
    x: Int,
    dir: Int,
    top: Int,
    baseline: Int,
    bottom: Int,
    text: CharSequence?,
    start: Int,
    end: Int,
    first: Boolean,
    layout: Layout?,
  ) {
    if (!first) return
    if (text is Spanned && text.getSpanStart(this) != start) return

    // Pass the paragraph origin: drawMarker reconstructs its offset from depth,
    // matching the x its own span would receive on a plain text line.
    val originX = if (dir > 0) 0 else layout?.width ?: 0
    marker.drawMarkerAt(c, p, originX, dir, top, baseline, bottom, layout, start)
  }
}
