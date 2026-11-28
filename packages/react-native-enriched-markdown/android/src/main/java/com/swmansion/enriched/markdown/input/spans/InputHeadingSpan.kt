package com.swmansion.enriched.markdown.input.spans

import android.annotation.SuppressLint
import android.graphics.Paint.FontMetricsInt
import android.graphics.Typeface
import android.text.TextPaint
import android.text.style.LineHeightSpan
import android.text.style.MetricAffectingSpan
import com.facebook.react.common.ReactConstants
import com.swmansion.enriched.markdown.input.formatting.MarkdownSpan
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle
import com.swmansion.enriched.markdown.utils.text.span.applyLineHeight
import kotlin.math.ceil

/**
 * Applies heading font size, weight, color, and line height to a markdown
 * heading paragraph. [InputFormatterStyle.headingStyle] picks the level style;
 * [BOLD_ITALIC_MASK] keeps inline bold/italic so emphasis composes with the
 * heading weight. Tagged [MarkdownSpan] for formatter cleanup.
 */
class InputHeadingSpan(
  val level: Int,
  style: InputFormatterStyle,
  private val lineHeightPx: Float?,
) : MetricAffectingSpan(),
  LineHeightSpan,
  MarkdownSpan {
  private val resolved = style.headingStyle(level)

  override fun updateDrawState(tp: TextPaint) {
    applyHeadingStyle(tp)
    resolved.color?.let { tp.color = it }
  }

  override fun updateMeasureState(tp: TextPaint) {
    applyHeadingStyle(tp)
  }

  override fun chooseHeight(
    text: CharSequence,
    start: Int,
    end: Int,
    spanstartv: Int,
    v: Int,
    fm: FontMetricsInt,
  ) {
    // null: no body lineHeight, so keep the font's natural height.
    val heightPx = lineHeightPx ?: return
    applyLineHeight(
      fm,
      ceil(heightPx.toDouble()).toInt(),
      start,
      end,
      text.length,
    )
  }

  @SuppressLint("WrongConstant") // Result of mask is always valid: 0, 1, 2, or 3
  private fun applyHeadingStyle(tp: TextPaint) {
    resolved.fontSizePx?.let { tp.textSize = it }

    if (resolved.fontWeight != ReactConstants.UNSET) {
      // Fold the configured heading weight into whatever bold/italic an inline span
      // already applied, so heading weight and inline emphasis compose instead of
      // one clobbering the other.
      val inlineStyle = (tp.typeface?.style ?: 0) and BOLD_ITALIC_MASK
      val headingBold = if (resolved.fontWeight >= BOLD_WEIGHT_THRESHOLD) Typeface.BOLD else 0
      val combined = inlineStyle or headingBold
      tp.typeface =
        if (combined != 0) {
          Typeface.create(tp.typeface, combined)
        } else {
          tp.typeface
        }
    }
  }

  companion object {
    private const val BOLD_ITALIC_MASK = Typeface.BOLD or Typeface.ITALIC

    // React Native treats weights >= 700 as bold.
    private const val BOLD_WEIGHT_THRESHOLD = 700
  }
}
