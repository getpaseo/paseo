package com.swmansion.enriched.markdown.utils.text.span

import android.graphics.Paint.FontMetricsInt
import kotlin.math.ceil
import kotlin.math.floor

/**
 * Splits extra leading above and below the line, copied from RN
 * CustomLineHeightSpan so we do not depend on React Native internal span types.
 *
 * Mirrors CustomLineHeightSpan.chooseHeight:
 * https://github.com/react/react-native/blob/v0.86.2/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/internal/span/CustomLineHeightSpan.kt#L44-L57
 *
 * Unlike RN, [lineHeight] is a floor, not a clamp: taller content grows the
 * line instead of being clipped (e.g. inline code taller than the paragraph,
 * https://github.com/software-mansion/enriched-markdown/issues/827).
 */
internal fun applyLineHeight(
  fm: FontMetricsInt,
  lineHeight: Int,
  start: Int,
  end: Int,
  textLength: Int,
) {
  val leading = lineHeight - ((-fm.ascent) + fm.descent)

  // Use lineHeight as a floor: if the default line-height is greater, don't
  // override it
  if (leading > 0) {
    fm.ascent -= ceil(leading / 2.0f).toInt()
    fm.descent += floor(leading / 2.0f).toInt()
  }

  if (start == 0) {
    fm.top = fm.ascent
  }
  if (end == textLength) {
    fm.bottom = fm.descent
  }
}
