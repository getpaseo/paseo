package sh.paseo.wordstream

import android.text.TextPaint
import android.text.style.CharacterStyle

/** Wall-clock milliseconds shared by every span on a surface; advanced once per frame. */
internal class FadeClock {
  var now: Long = 0L
}

/**
 * Software Mansion's alpha span with an absolute start time. Every grapheme
 * uses the same envelope, so opacity along the line is decided only by the
 * order of start times: a single front moving in reading order.
 */
internal class FadeInSpan(private val clock: FadeClock, val startAt: Long) : CharacterStyle() {
  val endsAt: Long get() = startAt + DURATION_MS

  override fun updateDrawState(tp: TextPaint) {
    val alpha = ((clock.now - startAt).toFloat() / DURATION_MS).coerceIn(0f, 1f)
    tp.color = multiplyAlpha(tp.color, alpha)
    tp.underlineColor = multiplyAlpha(tp.underlineColor, alpha)
  }

  private fun multiplyAlpha(color: Int, alpha: Float): Int {
    if (alpha >= 1f) return color
    if (alpha <= 0f) return color and 0x00FFFFFF
    val a = ((color ushr 24) * alpha).toInt()
    return (a shl 24) or (color and 0x00FFFFFF)
  }

  companion object {
    const val DURATION_MS = 150L
  }
}
