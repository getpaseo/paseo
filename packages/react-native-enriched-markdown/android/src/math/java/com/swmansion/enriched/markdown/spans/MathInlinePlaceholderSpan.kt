package com.swmansion.enriched.markdown.spans

import android.graphics.Canvas
import android.graphics.Paint
import android.text.style.ReplacementSpan
import kotlin.math.roundToInt

/** Holds pre-computed math metrics for background-thread measurement. */
class MathInlinePlaceholderSpan(
  private val metrics: MathMetrics,
) : ReplacementSpan() {
  override fun getSize(
    paint: Paint,
    text: CharSequence?,
    start: Int,
    end: Int,
    fm: Paint.FontMetricsInt?,
  ): Int {
    fm?.apply {
      ascent = -metrics.ascent.roundToInt()
      top = ascent
      descent = metrics.descent.roundToInt()
      bottom = descent
    }
    return metrics.width
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
    // Never displayed — measurement only.
  }
}
