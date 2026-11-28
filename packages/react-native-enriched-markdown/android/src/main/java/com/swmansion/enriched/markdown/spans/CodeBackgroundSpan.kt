package com.swmansion.enriched.markdown.spans

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.text.Spanned
import android.text.style.LineBackgroundSpan
import com.swmansion.enriched.markdown.spoiler.isConcealedBySpoiler
import com.swmansion.enriched.markdown.styles.StyleConfig
import kotlin.math.max
import kotlin.math.min

class CodeBackgroundSpan(
  private val styleConfig: StyleConfig,
) : LineBackgroundSpan {
  companion object {
    private const val CORNER_RADIUS = 6.0f
    private const val BORDER_WIDTH = 1.0f

    private val sharedBackgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val sharedBorderPaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = BORDER_WIDTH
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
      }
  }

  // Reusable drawing objects per instance
  private val rect = RectF()
  private val path = Path()

  override fun drawBackground(
    canvas: Canvas,
    p: Paint,
    left: Int,
    right: Int,
    top: Int,
    baseline: Int,
    bottom: Int,
    text: CharSequence,
    start: Int,
    end: Int,
    lineNum: Int,
  ) {
    if (text !is Spanned) return

    val spanStart = text.getSpanStart(this)
    val spanEnd = text.getSpanEnd(this)
    if (spanStart !in 0 until spanEnd) return

    // The spoiler overlay only covers the text's glyph box, so a background drawn to the line's bounds
    // would outline the hidden code around it.
    if (text.isConcealedBySpoiler(maxOf(spanStart, start), minOf(spanEnd, end))) return

    // Keep CodeSpan and this background span intact for semantic extraction. Draw only
    // portions outside replacement pills, including code surrounding a partially covered run.
    fun drawUncoveredRange(
      rangeStart: Int,
      rangeEnd: Int,
    ) {
      if (max(rangeStart, start) >= min(rangeEnd, end)) return
      // 1. Determine relative positioning
      val isFirst = rangeStart >= start
      val isLast = rangeEnd <= end

      // 2. Calculate coordinates
      val finalBottom = adjustBottomForMargin(text, end, bottom)
      val leadingMargin = InlineBackgroundGeometry.leadingMarginAt(text, start)
      val startX =
        if (isFirst) {
          InlineBackgroundGeometry.horizontalOffset(text, start, end, rangeStart, p, leadingMargin) + left
        } else {
          left.toFloat() + leadingMargin
        }
      val endX =
        if (isLast) {
          InlineBackgroundGeometry.horizontalOffset(text, start, end, rangeEnd, p, leadingMargin) + left
        } else {
          right.toFloat()
        }

      rect.set(min(startX, endX), top.toFloat(), max(startX, endX), finalBottom.toFloat())

      // 3. Apply Style
      val codeStyle = styleConfig.codeStyle
      sharedBackgroundPaint.color = codeStyle.backgroundColor
      sharedBorderPaint.color = codeStyle.borderColor

      drawShapes(canvas, isFirst, isLast)
    }

    // Runs per code span, per line, per draw: only query for pills if the style can produce any.
    val pills = if (styleConfig.hasLinkPills) text.getSpans(spanStart, spanEnd, LinkPillSpan::class.java) else emptyArray()
    if (pills.isEmpty()) {
      drawUncoveredRange(spanStart, spanEnd)
      return
    }
    if (pills.size > 1) pills.sortBy { text.getSpanStart(it) }
    var cursor = spanStart
    for (pill in pills) {
      val coveredStart = max(spanStart, text.getSpanStart(pill))
      val coveredEnd = min(spanEnd, text.getSpanEnd(pill))
      if (coveredStart >= coveredEnd) continue
      if (cursor < coveredStart) drawUncoveredRange(cursor, coveredStart)
      cursor = max(cursor, coveredEnd)
    }
    drawUncoveredRange(cursor, spanEnd)
  }

  private fun drawShapes(
    canvas: Canvas,
    isFirst: Boolean,
    isLast: Boolean,
  ) {
    val radii = createRadii(isFirst, isLast)

    path.reset()
    path.addRoundRect(rect, radii, Path.Direction.CW)
    canvas.drawPath(path, sharedBackgroundPaint)

    if (isFirst && isLast) {
      canvas.drawPath(path, sharedBorderPaint)
    } else {
      drawOpenBorders(canvas, isFirst, isLast)
    }
  }

  private fun drawOpenBorders(
    canvas: Canvas,
    isFirst: Boolean,
    isLast: Boolean,
  ) {
    val r = CORNER_RADIUS
    path.reset()

    if (isFirst) {
      path.moveTo(rect.right, rect.top)
      path.lineTo(rect.left + r, rect.top)
      path.quadTo(rect.left, rect.top, rect.left, rect.top + r)
      path.lineTo(rect.left, rect.bottom - r)
      path.quadTo(rect.left, rect.bottom, rect.left + r, rect.bottom)
      path.lineTo(rect.right, rect.bottom)
    } else if (isLast) {
      path.moveTo(rect.left, rect.top)
      path.lineTo(rect.right - r, rect.top)
      path.quadTo(rect.right, rect.top, rect.right, rect.top + r)
      path.lineTo(rect.right, rect.bottom - r)
      path.quadTo(rect.right, rect.bottom, rect.right - r, rect.bottom)
      path.lineTo(rect.left, rect.bottom)
    } else {
      path.moveTo(rect.left, rect.top)
      path.lineTo(rect.right, rect.top)
      path.moveTo(rect.left, rect.bottom)
      path.lineTo(rect.right, rect.bottom)
    }
    canvas.drawPath(path, sharedBorderPaint)
  }

  private fun createRadii(
    isFirst: Boolean,
    isLast: Boolean,
  ) = when {
    isFirst && isLast -> {
      floatArrayOf(
        CORNER_RADIUS,
        CORNER_RADIUS,
        CORNER_RADIUS,
        CORNER_RADIUS,
        CORNER_RADIUS,
        CORNER_RADIUS,
        CORNER_RADIUS,
        CORNER_RADIUS,
      )
    }

    isFirst -> {
      floatArrayOf(CORNER_RADIUS, CORNER_RADIUS, 0f, 0f, 0f, 0f, CORNER_RADIUS, CORNER_RADIUS)
    }

    isLast -> {
      floatArrayOf(0f, 0f, CORNER_RADIUS, CORNER_RADIUS, CORNER_RADIUS, CORNER_RADIUS, 0f, 0f)
    }

    else -> {
      floatArrayOf(0f, 0f, 0f, 0f, 0f, 0f, 0f, 0f)
    }
  }

  private fun adjustBottomForMargin(
    text: Spanned,
    lineEnd: Int,
    bottom: Int,
  ): Int {
    if (lineEnd <= 0 || lineEnd > text.length || text[lineEnd - 1] != '\n') return bottom
    val marginSpans = text.getSpans(lineEnd - 1, lineEnd, MarginBottomSpan::class.java)
    var adjusted = bottom
    for (span in marginSpans) {
      if (text.getSpanEnd(span) == lineEnd) adjusted -= span.marginBottom.toInt()
    }
    return adjusted
  }
}
