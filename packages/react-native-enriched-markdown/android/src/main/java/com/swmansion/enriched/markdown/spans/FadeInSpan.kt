package com.swmansion.enriched.markdown.spans

import android.os.Build
import android.text.TextPaint
import android.text.style.CharacterStyle
import androidx.annotation.FloatRange

class FadeInSpan : CharacterStyle() {
  @setparam:FloatRange(from = 0.0, to = 1.0)
  var alpha: Float = 0f

  override fun updateDrawState(tp: TextPaint) {
    tp.color = multiplyAlpha(tp.color, alpha)
    // Public from API 29; below that, underlines are drawn in `color`, which is already faded.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      tp.underlineColor = multiplyAlpha(tp.underlineColor, alpha)
    }
  }

  private fun multiplyAlpha(
    color: Int,
    alpha: Float,
  ): Int {
    if (alpha >= 1f) return color
    if (alpha <= 0f) return color and 0x00FFFFFF
    val a = ((color ushr 24) * alpha).toInt()
    return (a shl 24) or (color and 0x00FFFFFF)
  }
}
