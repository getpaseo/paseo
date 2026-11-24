package com.swmansion.enriched.markdown.spans

import android.graphics.Canvas
import android.graphics.Paint
import android.text.style.ReplacementSpan

class ThematicBreakSpan(
  private val lineColor: Int,
  private val lineHeight: Float,
  private val marginTop: Float,
  private val marginBottom: Float,
) : ReplacementSpan() {
  override fun getSize(
    paint: Paint,
    text: CharSequence?,
    start: Int,
    end: Int,
    fm: Paint.FontMetricsInt?,
  ): Int {
    val totalHeight = (marginTop + lineHeight + marginBottom).toInt()

    fm?.apply {
      ascent = -totalHeight
      top = -totalHeight
      descent = 0
      bottom = 0
    }

    return 0
  }

  override fun draw(
    canvas: Canvas,
    text: CharSequence?,
    start: Int,
    end: Int,
    x: Float,
    top: Int,
    y: Int,
    bottom: Int,
    paint: Paint,
  ) {
    paint.withStyle(lineColor, lineHeight) {
      val lineY = top + marginTop + (lineHeight / 2f)

      canvas.drawLine(0f, lineY, canvas.width.toFloat(), lineY, paint)
    }
  }

  private inline fun Paint.withStyle(
    color: Int,
    width: Float,
    action: () -> Unit,
  ) {
    val oldColor = this.color
    val oldWidth = this.strokeWidth
    val oldStyle = this.style

    this.color = color
    this.strokeWidth = width
    this.style = Paint.Style.STROKE

    action()

    this.color = oldColor
    this.strokeWidth = oldWidth
    this.style = oldStyle
  }
}
