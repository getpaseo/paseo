package com.swmansion.enriched.markdown.spoiler

import android.graphics.Color
import android.graphics.Paint
import android.text.Layout
import android.text.Spanned
import com.swmansion.enriched.markdown.spans.SpoilerSpan

internal fun computeSegmentRect(
  layout: Layout,
  line: Int,
  segmentStart: Int,
  segmentEnd: Int,
  fontMetrics: Paint.FontMetrics,
  paddingLeft: Float,
  paddingTop: Float,
): SegmentRect? {
  val startHorizontal = layout.getPrimaryHorizontal(segmentStart)
  val endHorizontal =
    if (segmentEnd >= layout.getLineEnd(line)) {
      layout.getLineRight(line)
    } else {
      layout.getPrimaryHorizontal(segmentEnd)
    }
  val baseline = layout.getLineBaseline(line).toFloat()

  val left = minOf(startHorizontal, endHorizontal) + paddingLeft
  val right = maxOf(startHorizontal, endHorizontal) + paddingLeft
  val top = baseline + fontMetrics.ascent + paddingTop
  val bottom = baseline + fontMetrics.descent + paddingTop
  val width = right - left
  val height = bottom - top
  return if (width > 0 && height > 0) SegmentRect(left, top, width, height) else null
}

internal fun colorWithAlpha(
  color: Int,
  alpha: Float,
): Int {
  val alphaComponent = (Color.alpha(color) * alpha).toInt().coerceIn(0, 255)
  return Color.argb(alphaComponent, Color.red(color), Color.green(color), Color.blue(color))
}

/**
 * Whether a spoiler still hides `[start, end)`. Once a reveal starts, the fading overlay lets the text show
 * through, so decorations drawn outside the text paint come back with it.
 */
internal fun Spanned.isConcealedBySpoiler(
  start: Int,
  end: Int,
): Boolean = getSpans(start, end, SpoilerSpan::class.java).any { !it.revealed && !it.revealing }
