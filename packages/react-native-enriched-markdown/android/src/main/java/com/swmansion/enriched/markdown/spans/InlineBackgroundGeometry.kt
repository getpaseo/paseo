package com.swmansion.enriched.markdown.spans

import android.graphics.Paint
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.LeadingMarginSpan

internal object InlineBackgroundGeometry {
  /**
   * Returns the x position of [index] relative to the line's left edge. The measuring layout keeps
   * the line's spans, so a LeadingMarginSpan is already folded into getPrimaryHorizontal — only the
   * early return, which builds no layout, adds [leadingMargin] itself.
   */
  fun horizontalOffset(
    text: CharSequence,
    lineStart: Int,
    lineEnd: Int,
    index: Int,
    paint: Paint,
    leadingMargin: Int,
  ): Float {
    if (index <= lineStart) return leadingMargin.toFloat()
    val lineText = text.subSequence(lineStart, lineEnd)
    val textPaint = paint as? TextPaint ?: TextPaint(paint)
    val layout = StaticLayout.Builder.obtain(lineText, 0, lineText.length, textPaint, 10000).build()
    return layout.getPrimaryHorizontal(index - lineStart)
  }

  fun leadingMarginAt(
    text: Spanned,
    lineStart: Int,
  ): Int {
    if (lineStart >= text.length) return 0
    val spans = text.getSpans(lineStart, lineStart + 1, LeadingMarginSpan::class.java)
    var margin = 0
    for (span in spans) {
      margin += span.getLeadingMargin(false)
    }
    return margin
  }
}
