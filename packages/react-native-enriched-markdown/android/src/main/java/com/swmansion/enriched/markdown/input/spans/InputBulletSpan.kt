package com.swmansion.enriched.markdown.input.spans

import android.graphics.Canvas
import android.graphics.Paint
import android.text.Layout
import android.text.Spanned
import android.text.style.LeadingMarginSpan
import com.swmansion.enriched.markdown.input.formatting.MarkdownSpan

/**
 * Bullet list item span: reserves a per-depth leading margin and draws the marker
 * glyph (dot / ring / square, capped at square for depth 2+) on the item's first line.
 * Mirrors the readonly renderer's bullet. Tagged [MarkdownSpan] for formatter
 * cleanup.
 */
class InputBulletSpan(
  val depth: Int,
  density: Float,
) : LeadingMarginSpan,
  MarkdownSpan {
  private val indentPerDepth = INDENT_PER_DEPTH_DP * density
  private val markerWidth = MARKER_WIDTH_DP * density

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

    // Bullet size tracks the text size (~30%), with a small floor so it stays visible.
    val size = (paint.textSize * BULLET_SIZE_RATIO).coerceAtLeast(MIN_BULLET_PX)
    val radius = size / 2f
    val centerX = x + (depth * indentPerDepth + markerWidth * 0.5f) * dir
    val fm = paint.fontMetrics
    val centerY = baseline + (fm.ascent + fm.descent) / 2f

    val originalStyle = paint.style
    val originalStrokeWidth = paint.strokeWidth
    when (if (depth >= 2) 2 else depth) {
      0 -> {
        paint.style = Paint.Style.FILL
        canvas.drawCircle(centerX, centerY, radius, paint)
      }

      1 -> {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = (size * RING_STROKE_RATIO).coerceAtLeast(1f)
        canvas.drawCircle(centerX, centerY, radius - paint.strokeWidth / 2f, paint)
      }

      else -> {
        paint.style = Paint.Style.FILL
        canvas.drawRect(centerX - radius, centerY - radius, centerX + radius, centerY + radius, paint)
      }
    }
    paint.style = originalStyle
    paint.strokeWidth = originalStrokeWidth
  }

  companion object {
    private const val INDENT_PER_DEPTH_DP = 18f
    private const val MARKER_WIDTH_DP = 18f
    private const val BULLET_SIZE_RATIO = 0.3f
    private const val MIN_BULLET_PX = 4f
    private const val RING_STROKE_RATIO = 0.15f
  }
}
