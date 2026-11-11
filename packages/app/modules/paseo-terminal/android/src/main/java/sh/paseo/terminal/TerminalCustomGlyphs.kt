package sh.paseo.terminal

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path

/**
 * Box drawing and block elements painted as cell geometry instead of font glyphs, so frames and
 * blocks join across cells regardless of the font's own metrics.
 */
internal class TerminalCustomGlyph(record: TerminalCustomGlyphRecord) {
  private val rects: FloatArray = FloatArray(record.rects.size) { record.rects[it].toFloat() }
  private val commands: DoubleArray = record.path
  private val strokeWidth: Float = record.strokeWidth.toFloat()
  private var scaledPath: Path? = null
  private var scaledWidth = 0f
  private var scaledHeight = 0f

  fun draw(canvas: Canvas, x: Float, width: Float, height: Float, density: Float, paint: Paint) {
    paint.style = Paint.Style.FILL
    var index = 0
    while (index + 3 < rects.size) {
      canvas.drawRect(
        x + rects[index] * width,
        rects[index + 1] * height,
        x + (rects[index] + rects[index + 2]) * width,
        (rects[index + 1] + rects[index + 3]) * height,
        paint,
      )
      index += 4
    }
    if (commands.isEmpty()) return
    val path = pathFor(width, height)
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = strokeWidth * density
    paint.strokeCap = Paint.Cap.BUTT
    paint.strokeJoin = Paint.Join.MITER
    canvas.save()
    canvas.translate(x, 0f)
    canvas.drawPath(path, paint)
    canvas.restore()
    paint.style = Paint.Style.FILL
  }

  private fun pathFor(width: Float, height: Float): Path {
    val cached = scaledPath
    if (cached != null && scaledWidth == width && scaledHeight == height) return cached
    val path = Path()
    var index = 0
    while (index < commands.size) {
      val x = { offset: Int -> commands[index + offset].toFloat() * width }
      val y = { offset: Int -> commands[index + offset].toFloat() * height }
      when (commands[index].toInt()) {
        0 -> { path.moveTo(x(1), y(2)); index += 3 }
        1 -> { path.lineTo(x(1), y(2)); index += 3 }
        2 -> { path.quadTo(x(1), y(2), x(3), y(4)); index += 5 }
        else -> index = commands.size
      }
    }
    scaledPath = path
    scaledWidth = width
    scaledHeight = height
    return path
  }
}

internal class TerminalCustomGlyphs(records: List<TerminalCustomGlyphRecord>) {
  private val glyphs: Map<String, TerminalCustomGlyph> =
    records.associate { it.char to TerminalCustomGlyph(it) }

  operator fun get(text: String): TerminalCustomGlyph? = glyphs[text]

  companion object {
    val EMPTY = TerminalCustomGlyphs(emptyList())
  }
}
