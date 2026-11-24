package com.swmansion.enriched.markdown.spans

import android.graphics.Paint
import kotlin.math.ceil
import kotlin.math.floor
import android.text.style.LineHeightSpan as AndroidLineHeightSpan

class LineHeightSpan(
  height: Float,
) : AndroidLineHeightSpan {
  private val lineHeight: Int = ceil(height.toDouble()).toInt()

  /**
   * Distributes positive leading evenly above and below the line to reach
   * lineHeight.
   *
   * When the line's natural content is already at least as tall as lineHeight
   * (leading <= 0), we keep the natural metrics and return early. Forcing the
   * smaller lineHeight by shrinking ascent/descent clips tall glyphs (e.g.
   * stacked combining marks) and drags the whole line up (issue #643); letting
   * the line grow to fit its content avoids that. Normally-sized lines have
   * positive leading and are unaffected.
   */
  override fun chooseHeight(
    text: CharSequence?,
    start: Int,
    end: Int,
    spanstartv: Int,
    v: Int,
    fm: Paint.FontMetricsInt?,
  ) {
    if (fm == null) return

    val leading = lineHeight - ((-fm.ascent) + fm.descent)
    if (leading <= 0) return
    fm.ascent -= ceil(leading / 2.0f).toInt()
    fm.descent += floor(leading / 2.0f).toInt()
  }
}
