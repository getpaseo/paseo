package com.swmansion.enriched.markdown.spans

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.text.Layout
import com.swmansion.enriched.markdown.renderer.BlockStyle
import com.swmansion.enriched.markdown.renderer.SpanStyleCache
import com.swmansion.enriched.markdown.styles.ListStyle
import com.swmansion.enriched.markdown.styles.TaskListStyle

class TaskListSpan(
  private val taskStyle: TaskListStyle,
  private val listStyle: ListStyle,
  depth: Int,
  context: Context,
  styleCache: SpanStyleCache,
  val taskIndex: Int,
  val isChecked: Boolean,
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
  private val checkboxSize = taskStyle.checkboxSize
  private val markerColumnWidth = listStyle.effectiveMarkerWidth(checkboxSize)
  private val cornerRadius = taskStyle.checkboxBorderRadius
  private val rect = RectF()
  private val checkPath = Path()

  companion object {
    private const val CAP_HEIGHT_RATIO = 0.72f
    private const val HALF_DIVISOR = 2f
    private const val CHECKMARK_MIN_STROKE_WIDTH = 1.5f
    private const val CHECKMARK_STROKE_RATIO = 0.12f
    private const val CHECKMARK_INSET_RATIO = 0.22f
    private const val CHECKMARK_MID_OFFSET_RATIO = 0.05f
    private const val BORDER_MIN_STROKE_WIDTH = 1f
    private const val BORDER_STROKE_RATIO = 0.09f
  }

  private val boxPaint =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
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
    val capHeight = -markerFontMetrics.ascent * CAP_HEIGHT_RATIO
    val centerY = baseline - capHeight / HALF_DIVISOR
    // Right-align the checkbox inside the reserved marker column so it hugs
    // the gap before the text. At the default (markerColumnWidth ==
    // checkboxSize) this is identical to the previous flush-left layout.
    val centerX = x + (depth * marginLeft + markerColumnWidth - checkboxSize / HALF_DIVISOR) * dir
    val half = checkboxSize / HALF_DIVISOR
    rect.set(centerX - half, centerY - half, centerX + half, centerY + half)

    if (isChecked) {
      drawChecked(canvas, centerY)
    } else {
      drawUnchecked(canvas)
    }
  }

  private fun drawChecked(
    canvas: Canvas,
    centerY: Float,
  ) {
    boxPaint.apply {
      style = Paint.Style.FILL
      color = taskStyle.checkedColor
    }
    canvas.drawRoundRect(rect, cornerRadius, cornerRadius, boxPaint)

    boxPaint.apply {
      style = Paint.Style.STROKE
      color = taskStyle.checkmarkColor
      strokeWidth = maxOf(CHECKMARK_MIN_STROKE_WIDTH, checkboxSize * CHECKMARK_STROKE_RATIO)
    }

    val inset = checkboxSize * CHECKMARK_INSET_RATIO
    val midOffset = checkboxSize * CHECKMARK_MID_OFFSET_RATIO

    checkPath.run {
      reset()
      moveTo(rect.left + inset, centerY)
      lineTo(rect.centerX() - midOffset, rect.bottom - inset)
      lineTo(rect.right - inset, rect.top + inset)
    }
    canvas.drawPath(checkPath, boxPaint)
  }

  private fun drawUnchecked(canvas: Canvas) {
    boxPaint.apply {
      style = Paint.Style.STROKE
      color = taskStyle.borderColor
      strokeWidth = maxOf(BORDER_MIN_STROKE_WIDTH, checkboxSize * BORDER_STROKE_RATIO)
    }

    val halfStroke = boxPaint.strokeWidth / 2f
    val insetRect =
      RectF(
        rect.left + halfStroke,
        rect.top + halfStroke,
        rect.right - halfStroke,
        rect.bottom - halfStroke,
      )
    canvas.drawRoundRect(insetRect, cornerRadius, cornerRadius, boxPaint)
  }
}
