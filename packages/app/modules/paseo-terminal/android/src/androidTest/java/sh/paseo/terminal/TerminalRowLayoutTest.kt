package sh.paseo.terminal

import android.os.Build
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

private const val COLUMNS = 8

/** Rasters that draw the same clusters match exactly; a wrong clustering differs by 0.12 or more. */
private const val MATCH_TOLERANCE = 0.01f

@RunWith(AndroidJUnit4::class)
class TerminalRowLayoutTest {
  private val font = TerminalFont("monospace", 40f, 1f)
  private val paints = TerminalPaints()

  /**
   * Draws each row of `grapheme-rows.json` and compares it with its grapheme clusters drawn one at a
   * time, each centred in its own columns. `terminal-frame.test.ts` checks that the rows are what
   * xterm produces and that the clusters are UAX #29 grapheme clusters.
   */
  @Test
  fun drawsEachGraphemeClusterInItsOwnColumns() {
    val assets = InstrumentationRegistry.getInstrumentation().context.assets
    val rows = JSONArray(assets.open("grapheme-rows.json").bufferedReader().readText())
    for (index in 0 until rows.length()) {
      val row = rows.getJSONObject(index)
      val source = TerminalRowSource.decode(row.getString("row"))
      val layout = TerminalRowLayout(source, font, TerminalCustomGlyphs.EMPTY)
      // Selection covers row 0 only, so drawing as row 1 draws nothing selected.
      val drawn = raster { layout.drawSelected(it, 1, TerminalSelection(TerminalSelectionRecord()), paints) }
      val expected = raster { drawClusters(it, source, starts(row, "clusterStarts")) }
      val contrast = raster { drawClusters(it, source, starts(row, "contrastStarts")) }
      val output = row.getString("output")
      val (toExpected, toContrast) = difference(drawn, expected) to difference(drawn, contrast)
      Log.i("TerminalRowLayoutTest", "$output expected=$toExpected contrast=$toContrast")
      // Android 10's platform ICU splits this conjunct. Keep its observed raster baseline
      // explicit rather than claiming this supported OS passes the modern grapheme corpus.
      if (Build.VERSION.SDK_INT == 29 && output == "स्ते") {
        assertTrue("Android 10 unexpectedly matches modern conjunct clustering", toExpected > MATCH_TOLERANCE)
        assertTrue("Android 10 split-conjunct baseline changed", toContrast <= MATCH_TOLERANCE)
        continue
      }
      assertTrue("$output differs from its grapheme clusters by $toExpected", toExpected <= MATCH_TOLERANCE)
      assertTrue("$output also matches the wrong clusters", toContrast > MATCH_TOLERANCE)
    }
  }

  @Test
  fun selectionCompositesOverCellAndTerminalBackgroundsWithoutChangingForeground() {
    val red = 0xffff0000.toInt()
    val green = 0xff00aa00.toInt()
    val overlay = 0x472684ff
    val source = TerminalRowSource.decode("1,1;1,4294901760,4278233600,0;M")
    val layout = TerminalRowLayout(source, font, TerminalCustomGlyphs.EMPTY)
    paints.selectionBackground = overlay
    for (terminalBackground in listOf(0xffffffff.toInt(), 0xff000000.toInt())) {
      val actual = raster { canvas ->
        canvas.drawColor(terminalBackground)
        layout.drawSelected(canvas, 0, TerminalSelection(TerminalSelectionRecord()), paints)
      }
      val expected = raster { canvas ->
        canvas.drawColor(terminalBackground)
        canvas.drawColor(green)
        canvas.drawColor(overlay)
      }
      assertEquals(expected.getPixel(0, 0), actual.getPixel(0, 0))
      assertTrue("selected glyph retains its red foreground", (0 until font.cellHeightPx).any { y ->
        (0 until font.cellWidthPx).any { x -> actual.getPixel(x, y) == red }
      })
    }
    val defaultBackground = TerminalRowLayout(TerminalRowSource.decode("1,1;1,4294901760,0,0;M"), font, TerminalCustomGlyphs.EMPTY)
    for (terminalBackground in listOf(0xffffffff.toInt(), 0xff000000.toInt())) {
      val actual = raster { canvas ->
        canvas.drawColor(terminalBackground)
        defaultBackground.drawSelected(canvas, 0, TerminalSelection(TerminalSelectionRecord()), paints)
      }
      val expected = raster { canvas -> canvas.drawColor(terminalBackground); canvas.drawColor(overlay) }
      assertEquals(expected.getPixel(0, 0), actual.getPixel(0, 0))
    }
  }

  private fun starts(row: JSONObject, key: String): List<Int> =
    row.getJSONArray(key).let { starts -> List(starts.length()) { starts.getInt(it) } }

  private fun raster(draw: (Canvas) -> Unit): Bitmap {
    val bitmap = Bitmap.createBitmap(COLUMNS * font.cellWidthPx, font.cellHeightPx, Bitmap.Config.ARGB_8888)
    draw(Canvas(bitmap))
    return bitmap
  }

  /** Draws each cluster as its own text, centred in its columns and scaled down when wider. */
  private fun drawClusters(canvas: Canvas, source: TerminalRowSource, starts: List<Int>) {
    val cellCount = source.cells.size / 2
    val paint = Paint(font.paint(0)).apply { color = source.styles[1].toLong().toInt() }
    val offsets = IntArray(cellCount + 1)
    val cols = IntArray(cellCount + 1)
    for (cell in 0 until cellCount) {
      offsets[cell + 1] = offsets[cell] + source.cells[cell * 2]
      cols[cell + 1] = cols[cell] + source.cells[cell * 2 + 1]
    }
    for ((index, first) in starts.withIndex()) {
      val end = starts.getOrElse(index + 1) { cellCount }
      val text = source.text.substring(offsets[first], offsets[end])
      if (text.isBlank()) continue
      val slot = (cols[end] - cols[first]) * font.cellWidthPx.toFloat()
      val advance = paint.measureText(text)
      val x = cols[first] * font.cellWidthPx + if (advance > slot + 1f) 0f else (slot - advance) / 2f
      canvas.save()
      if (advance > slot + 1f) canvas.scale(slot / advance, slot / advance, x, font.cellHeightPx / 2f)
      canvas.drawText(text, x, font.baselinePx.toFloat(), paint)
      canvas.restore()
    }
  }

  /** Share of inked pixels, in either image, whose coverage differs by more than a quarter. */
  private fun difference(a: Bitmap, b: Bitmap): Float {
    var inked = 0
    var differing = 0
    for (y in 0 until a.height) {
      for (x in 0 until a.width) {
        val (left, right) = (a.getPixel(x, y) ushr 24) to (b.getPixel(x, y) ushr 24)
        if (left < 64 && right < 64) continue
        inked += 1
        if (kotlin.math.abs(left - right) > 64) differing += 1
      }
    }
    return if (inked == 0) 0f else differing.toFloat() / inked
  }
}
