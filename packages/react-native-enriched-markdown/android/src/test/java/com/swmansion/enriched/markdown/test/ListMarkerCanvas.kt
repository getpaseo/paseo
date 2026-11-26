package com.swmansion.enriched.markdown.test

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.text.Layout
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextDirectionHeuristics
import android.text.TextPaint
import com.swmansion.enriched.markdown.spans.BaseListSpan

/** A list marker as the layout drew it: a number, a bullet, or a checkbox. */
data class DrawnMarker(
  val left: Float,
  val right: Float,
  val baseline: Float,
)

/** A drawn marker with the text edges, direction and list depth of the paragraph it belongs to. */
data class MarkerGeometry(
  val marker: DrawnMarker,
  val paragraphLeft: Float,
  val depth: Int,
  val paragraphRight: Float,
  val direction: Int,
)

/** Records the list markers a layout draws instead of painting them. */
class MarkerCanvas : Canvas(Bitmap.createBitmap(LAYOUT_WIDTH, 1, Bitmap.Config.ARGB_8888)) {
  val markers = mutableListOf<DrawnMarker>()

  // Layout draws only the lines inside the clip; report one tall enough for every list.
  override fun getClipBounds(bounds: Rect): Boolean {
    bounds.set(0, 0, LAYOUT_WIDTH, Int.MAX_VALUE / 2)
    return true
  }

  override fun drawCircle(
    cx: Float,
    cy: Float,
    radius: Float,
    paint: Paint,
  ) {
    // Bullets are centered on the reserved column edge, matching the iOS drawer.
    val outerRadius = radius + paint.strokeWidth / 2f
    markers += DrawnMarker(cx - outerRadius, cx, cy)
    super.drawCircle(cx, cy, radius, paint)
  }

  override fun drawRect(
    left: Float,
    top: Float,
    right: Float,
    bottom: Float,
    paint: Paint,
  ) {
    // Bullets from depth 2 on are squares, centered like the round ones.
    markers += DrawnMarker(left, (left + right) / 2f, (top + bottom) / 2f)
    super.drawRect(left, top, right, bottom, paint)
  }

  override fun drawRoundRect(
    rect: RectF,
    rx: Float,
    ry: Float,
    paint: Paint,
  ) {
    val halfStroke = if (paint.style == Paint.Style.STROKE) paint.strokeWidth / 2f else 0f
    markers += DrawnMarker(rect.left - halfStroke, rect.right + halfStroke, rect.centerY())
    super.drawRoundRect(rect, rx, ry, paint)
  }

  override fun drawText(
    text: String,
    x: Float,
    y: Float,
    paint: Paint,
  ) {
    if (text.matches(Regex("(?:[0-9]+\\.|\\.[0-9]+)"))) markers += DrawnMarker(x, x + paint.measureText(text), y)
    super.drawText(text, x, y, paint)
  }

  companion object {
    const val LAYOUT_WIDTH = 2000

    fun layout(
      text: CharSequence,
      textSize: Float,
      rtl: Boolean = false,
    ): StaticLayout =
      StaticLayout.Builder
        .obtain(text, 0, text.length, TextPaint().apply { this.textSize = textSize }, LAYOUT_WIDTH)
        .apply { if (rtl) setTextDirection(TextDirectionHeuristics.RTL) }
        .build()

    /** The markers [layout] draws, top to bottom. */
    fun drawMarkers(layout: Layout): List<DrawnMarker> =
      MarkerCanvas().also(layout::draw).markers.sortedWith(compareBy({ it.baseline }, { it.left }))

    /** Every marker [layout] draws, with the text edges, direction and depth of its paragraph. */
    fun markerGeometry(
      text: Spanned,
      layout: Layout,
    ): List<MarkerGeometry> =
      drawMarkers(layout).map { marker ->
        val line = layout.getLineForVertical(marker.baseline.toInt())
        val start = layout.getLineStart(line)
        val depth = text.getSpans(start, start + 1, BaseListSpan::class.java).maxOf { it.depth }
        MarkerGeometry(
          marker,
          layout.getParagraphLeft(line).toFloat(),
          depth,
          layout.getParagraphRight(line).toFloat(),
          layout.getParagraphDirection(line),
        )
      }
  }
}
