package sh.paseo.terminal

import android.graphics.Paint
import android.graphics.Typeface
import kotlin.math.max
import kotlin.math.roundToInt

private const val MEASURE_TEXT = "mmmmmmmmmm"

/**
 * The terminal font at one pixel size: a paint per face (regular, bold, italic, bold italic) and
 * the cell those faces are laid out on. Cells are whole device pixels so every column origin is
 * exact. Platform fallback fonts cover characters the family lacks.
 */
internal class TerminalFont(val family: String, val sizePx: Float, val density: Float) {
  private val faces: Array<Paint> = Array(4) { face ->
    Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply {
      typeface = Typeface.create(family, typefaceStyle(face))
      textSize = sizePx
    }
  }

  val cellWidthPx: Int
  val cellHeightPx: Int
  val baselinePx: Int
  val underlineOffsetPx: Float
  val underlineThicknessPx: Float
  val strikeOffsetPx: Float
  val strikeThicknessPx: Float

  init {
    val regular = faces[0]
    cellWidthPx = max(1, (regular.measureText(MEASURE_TEXT) / MEASURE_TEXT.length).roundToInt())
    val metrics = regular.fontMetricsInt
    cellHeightPx = max(1, metrics.descent - metrics.ascent)
    baselinePx = -metrics.ascent
    underlineOffsetPx = regular.underlinePosition
    underlineThicknessPx = max(1f, regular.underlineThickness)
    strikeOffsetPx = regular.strikeThruPosition
    strikeThicknessPx = max(1f, regular.strikeThruThickness)
  }

  /** Paint for a style's face; callers only change its color. */
  fun paint(flags: Int): Paint = faces[face(flags)]

  fun sameAs(family: String, sizePx: Float, density: Float): Boolean =
    this.family == family && this.sizePx == sizePx && this.density == density

  companion object {
    fun face(flags: Int): Int =
      (if (flags and TerminalStyleFlags.BOLD != 0) 1 else 0) +
        (if (flags and TerminalStyleFlags.ITALIC != 0) 2 else 0)

    private fun typefaceStyle(face: Int): Int = when (face) {
      1 -> Typeface.BOLD
      2 -> Typeface.ITALIC
      3 -> Typeface.BOLD_ITALIC
      else -> Typeface.NORMAL
    }
  }
}
