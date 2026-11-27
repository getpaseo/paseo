package com.swmansion.enriched.markdown.spans

import android.graphics.Paint
import android.text.Spanned
import android.text.style.LineHeightSpan

/**
 * Adds vertical spacing between list items using LineHeightSpan.
 *
 * Attached over the newline that separates two items; extends only the line
 * ending at that newline so the gap appears below the preceding item.
 *
 * @param spacing The spacing in pixels to add below the line (0 = no spacing)
 */
class ListItemSpacingSpan(
  val spacing: Float,
) : LineHeightSpan {
  override fun chooseHeight(
    text: CharSequence,
    start: Int,
    end: Int,
    spanstartv: Int,
    lineHeight: Int,
    fm: Paint.FontMetricsInt,
  ) {
    val spanEnd = (text as? Spanned)?.getSpanEnd(this) ?: return
    if (end != spanEnd) return

    val spacingPixels = spacing.toInt()
    fm.descent += spacingPixels
    fm.bottom += spacingPixels
  }
}
