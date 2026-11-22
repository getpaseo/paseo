package com.swmansion.enriched.markdown.spans

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.text.Layout
import com.swmansion.enriched.markdown.renderer.BlockStyle
import com.swmansion.enriched.markdown.renderer.SpanStyleCache
import com.swmansion.enriched.markdown.styles.ListStyle

class UnorderedListSpan(
  private val listStyle: ListStyle,
  depth: Int,
  context: Context,
  styleCache: SpanStyleCache,
  drawsMarker: Boolean = true,
) : BaseListSpan(
    depth = depth,
    context = context,
    styleCache = styleCache,
    blockStyle =
      BlockStyle(
        fontSize = listStyle.fontSize,
        fontFamily = listStyle.fontFamily,
        fontWeight = listStyle.fontWeight,
        color = listStyle.color,
      ),
    marginLeft = listStyle.marginLeft,
    gapWidth = listStyle.gapWidth,
    drawsMarker = drawsMarker,
  ) {
  companion object {
    private val sharedBulletPaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
      }
  }

  private val radius: Float = listStyle.bulletSize / 2f
  private val ringStrokeWidth: Float = radius * 0.3f
  private val markerColumnWidth: Float = listStyle.effectiveMarkerWidth(radius)

  private fun configureBulletPaint(): Paint =
    sharedBulletPaint.apply {
      color = listStyle.bulletColor
      style = Paint.Style.FILL
      strokeWidth = 0f
    }

  override fun getMarkerWidth(): Float = markerColumnWidth

  override fun drawMarker(
    canvas: Canvas,
    paint: Paint,
    x: Int,
    dir: Int,
    top: Int,
    baseline: Int,
    bottom: Int,
    layout: Layout?,
    start: Int,
  ) {
    val bulletPaint = configureBulletPaint()
    // Center the bullet at the right edge of the reserved marker column so
    // it hugs the gap before the text — matches iOS behavior and stays
    // visually flush-left when the column width equals the bullet radius
    // (the default).
    val bulletX = x + (depth * marginLeft + markerColumnWidth) * dir
    val bulletY = baseline + (markerFontMetrics.ascent + markerFontMetrics.descent) / 2f

    when (depth) {
      0 -> {
        canvas.drawCircle(bulletX, bulletY, radius, bulletPaint)
      }

      1 -> {
        bulletPaint.style = Paint.Style.STROKE
        bulletPaint.strokeWidth = ringStrokeWidth
        canvas.drawCircle(bulletX, bulletY, radius - ringStrokeWidth / 2f, bulletPaint)
      }

      else -> {
        canvas.drawRect(
          bulletX - radius,
          bulletY - radius,
          bulletX + radius,
          bulletY + radius,
          bulletPaint,
        )
      }
    }
  }
}
