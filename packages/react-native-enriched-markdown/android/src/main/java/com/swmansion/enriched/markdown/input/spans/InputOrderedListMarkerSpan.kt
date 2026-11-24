package com.swmansion.enriched.markdown.input.spans

import android.graphics.Canvas
import android.graphics.Paint
import android.text.Layout
import android.text.Spanned
import android.text.style.LeadingMarginSpan
import com.swmansion.enriched.markdown.input.formatting.MarkdownSpan

/**
 * Ordered list item span: reserves the same per-depth leading margin as
 * [InputBulletSpan] and draws the item's number ("3.") right-aligned before the
 * text column. The ordinal comes from the block store's list-metadata pass.
 * Tagged [MarkdownSpan] for formatter cleanup.
 */
class InputOrderedListMarkerSpan(
  val depth: Int,
  private val ordinal: Int,
  density: Float,
) : LeadingMarginSpan,
  MarkdownSpan {
  private val indentPerDepth = INDENT_PER_DEPTH_DP * density
  private val markerWidth = MARKER_WIDTH_DP * density
  private val markerGap = MARKER_GAP_DP * density

  override fun getLeadingMargin(first: Boolean): Int = (depth * indentPerDepth + markerWidth).toInt()

  override fun drawLeadingMargin(
    canvas: Canvas,
    paint: Paint,
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
    // Wrapped continuation lines also report first=true; draw only on the visual
    // line where this span actually begins.
    if (text is Spanned && text.getSpanStart(this) != start) return

    // RTL (dir < 0) mirrors the marker to the trailing side and flips the label
    // to ".3", matching the readonly renderer's OrderedListSpan.
    val label = if (dir < 0) ".$ordinal" else "$ordinal."
    val originalAlign = paint.textAlign
    paint.textAlign = if (dir < 0) Paint.Align.LEFT else Paint.Align.RIGHT
    val markerEdge = x + (depth * indentPerDepth + markerWidth - markerGap) * dir
    canvas.drawText(label, markerEdge, baseline.toFloat(), paint)
    paint.textAlign = originalAlign
  }

  companion object {
    // Geometry mirrors InputBulletSpan so ordered and bullet items align.
    private const val INDENT_PER_DEPTH_DP = 18f
    private const val MARKER_WIDTH_DP = 18f
    private const val MARKER_GAP_DP = 4f
  }
}
