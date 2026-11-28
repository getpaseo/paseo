package com.swmansion.enriched.markdown.spans

import android.annotation.SuppressLint
import android.graphics.Typeface
import android.text.TextPaint
import android.text.style.MetricAffectingSpan
import com.swmansion.enriched.markdown.styles.StyleConfig

class HeadingSpan(
  val level: Int,
  styleConfig: StyleConfig,
) : MetricAffectingSpan() {
  private val fontSize: Float = styleConfig.headingStyles[level]!!.fontSize
  private val color: Int = styleConfig.headingStyles[level]!!.color
  private val cachedTypeface: Typeface? = styleConfig.headingTypefaces[level]

  override fun updateDrawState(tp: TextPaint) {
    applyHeadingStyle(tp)
    tp.color = color
  }

  override fun updateMeasureState(tp: TextPaint) {
    applyHeadingStyle(tp)
  }

  @SuppressLint("WrongConstant") // Result of mask is always valid: 0, 1, 2, or 3
  private fun applyHeadingStyle(tp: TextPaint) {
    tp.textSize = fontSize
    cachedTypeface?.let { base ->
      val preserved = (tp.typeface?.style ?: 0) and BOLD_ITALIC_MASK
      tp.typeface = if (preserved != 0) Typeface.create(base, preserved) else base
    }
  }

  companion object {
    private const val BOLD_ITALIC_MASK = Typeface.BOLD or Typeface.ITALIC
  }
}
