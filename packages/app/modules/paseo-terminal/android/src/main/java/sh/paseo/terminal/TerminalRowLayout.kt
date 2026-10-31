package sh.paseo.terminal

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RenderNode
import android.graphics.text.MeasuredText
import android.icu.text.BreakIterator

/** Shaped glyphs may exceed their slot by this many pixels before they are scaled down. */
private const val OVERFLOW_TOLERANCE_PX = 1f
/** Stands in for an open edge when a group is clipped on one side only. */
private const val CLIP_UNBOUNDED_PX = 100_000f

/**
 * One row shaped once and placed on the terminal grid.
 *
 * Each run of cells with the same font face is shaped as a whole, so contextual forms, ligatures,
 * marks and fallback fonts see their neighbours. The shaper reports a cluster's advance on its
 * first UTF-16 unit and zero on the units it absorbed. A cell whose first unit has zero advance
 * therefore belongs to the cluster of the cell before it: a ligature, conjunct, emoji sequence or
 * reordered mark that spans columns. A cell that does not start a grapheme cluster also stays with
 * the cell before it: a half-form conjunct such as स्त keeps both consonants' advances, and drawing
 * either half alone would show an explicit virama. Each resulting group is drawn from the shaped
 * run (in context) at its first cell's column, centred in the columns it owns, and scaled down only when
 * its glyphs are wider than those columns. Colors never split groups or reshape the row: a group
 * whose cells differ in color or selection is drawn once per color, clipped to those cells' columns.
 */
internal class TerminalRowLayout(
  val source: TerminalRowSource,
  private val font: TerminalFont,
  private val customGlyphs: TerminalCustomGlyphs,
) {
  private val chars: CharArray = source.text.toCharArray()
  private val cellCount = source.cells.size / 2
  private val cellCol = IntArray(cellCount)
  private val cellSpan = IntArray(cellCount)
  private val cellStart = IntArray(cellCount)
  private val cellEnd = IntArray(cellCount)
  private val cellForeground = IntArray(cellCount)
  private val cellBackground = IntArray(cellCount)
  private val cellFlags = IntArray(cellCount)
  private val cellGlyph = arrayOfNulls<TerminalCustomGlyph>(cellCount)
  private val groups = ArrayList<Group>()
  private val measured: MeasuredText?
  val text: String get() = source.text

  private var node: RenderNode? = null

  private class Group(
    val firstCell: Int,
    val lastCell: Int,
    val col: Int,
    val start: Int,
    val end: Int,
    val contextStart: Int,
    val contextEnd: Int,
    val offsetPx: Float,
    val scale: Float,
    val blank: Boolean,
  )

  init {
    readCells()
    measured = measure()
    if (measured != null) buildGroups(measured)
  }

  private fun readCells() {
    var offset = 0
    var col = 0
    var styleIndex = 0
    var styleEndCol = 0
    for (cell in 0 until cellCount) {
      val length = source.cells[cell * 2]
      val span = maxOf(1, source.cells[cell * 2 + 1])
      while (col >= styleEndCol && styleIndex + 3 < source.styles.size) {
        styleEndCol += source.styles[styleIndex].toInt()
        styleIndex += 4
      }
      val style = styleIndex - 4
      if (style >= 0) {
        cellForeground[cell] = argb(source.styles[style + 1])
        cellBackground[cell] = argb(source.styles[style + 2])
        cellFlags[cell] = source.styles[style + 3].toInt()
      }
      cellCol[cell] = col
      cellSpan[cell] = span
      cellStart[cell] = offset
      cellEnd[cell] = minOf(chars.size, offset + length)
      cellGlyph[cell] = customGlyphs[source.text.substring(cellStart[cell], cellEnd[cell])]
      offset = cellEnd[cell]
      col += span
    }
  }

  /** Same face, not custom glyph: cells shaped together. */
  private fun shapesWith(cell: Int, other: Int): Boolean =
    cellGlyph[cell] == null && cellGlyph[other] == null &&
      TerminalFont.face(cellFlags[cell]) == TerminalFont.face(cellFlags[other])

  private fun measure(): MeasuredText? {
    if (chars.isEmpty()) return null
    val builder = MeasuredText.Builder(chars)
    var cell = 0
    while (cell < cellCount) {
      var last = cell
      while (last + 1 < cellCount && shapesWith(cell, last + 1)) last += 1
      val length = cellEnd[last] - cellStart[cell]
      if (length > 0) {
        if (cellGlyph[cell] != null) {
          builder.appendReplacementRun(font.paint(cellFlags[cell]), length, 0f)
        } else {
          builder.appendStyleRun(font.paint(cellFlags[cell]), length, false)
        }
      }
      cell = last + 1
    }
    val trailing = chars.size - (if (cellCount > 0) cellEnd[cellCount - 1] else 0)
    if (trailing > 0) builder.appendReplacementRun(font.paint(0), trailing, 0f)
    return builder.build()
  }

  private fun buildGroups(measured: MeasuredText) {
    // Keep platform graphemes together even when Minikin reports separate advances/cursors.
    // Rules follow the OS ICU version: Android 10 splits Indic conjuncts such as स्ते.
    val graphemes = BreakIterator.getCharacterInstance()
    graphemes.setText(source.text)
    var cell = 0
    while (cell < cellCount) {
      if (cellGlyph[cell] != null) {
        cell += 1
        continue
      }
      var last = cell
      while (last + 1 < cellCount && shapesWith(cell, last + 1)) last += 1
      val contextStart = cellStart[cell]
      val contextEnd = cellEnd[last]
      var first = cell
      for (next in cell + 1..last) {
        val startsCluster =
          cellEnd[next] > cellStart[next] &&
            measured.getCharWidthAt(cellStart[next]) != 0f &&
            graphemes.isBoundary(cellStart[next])
        if (startsCluster) {
          addGroup(measured, first, next - 1, contextStart, contextEnd)
          first = next
        }
      }
      addGroup(measured, first, last, contextStart, contextEnd)
      cell = last + 1
    }
  }

  private fun addGroup(measured: MeasuredText, first: Int, last: Int, contextStart: Int, contextEnd: Int) {
    val start = cellStart[first]
    val end = cellEnd[last]
    if (end <= start) return
    var columns = 0
    for (cell in first..last) columns += cellSpan[cell]
    val slot = (columns * font.cellWidthPx).toFloat()
    val advance = measured.getWidth(start, end)
    val scale = if (advance > slot + OVERFLOW_TOLERANCE_PX) slot / advance else 1f
    val offset = if (scale < 1f) 0f else (slot - advance) / 2f
    var blank = true
    for (index in start until end) {
      if (chars[index] != ' ') {
        blank = false
        break
      }
    }
    groups.add(Group(first, last, cellCol[first], start, end, contextStart, contextEnd, offset, scale, blank))
  }

  /** Draws the row with its own colors, replaying a recorded display list when possible. */
  fun draw(canvas: Canvas, width: Int, paints: TerminalPaints) {
    if (!canvas.isHardwareAccelerated) {
      drawContent(canvas, -1, null, paints)
      return
    }
    // Marks stacked above or below a letter ink outside the row. The node must not clip them: the
    // view redraws every row on each frame, so ink outside the row is never left stale.
    val recorded = node ?: RenderNode("terminal-row").also {
      it.setClipToBounds(false)
      node = it
    }
    if (!recorded.hasDisplayList() || recorded.width != width) {
      recorded.setPosition(0, 0, width, font.cellHeightPx)
      val recording = recorded.beginRecording()
      try {
        drawContent(recording, -1, null, paints)
      } finally {
        recorded.endRecording()
      }
    }
    canvas.drawRenderNode(recorded)
  }

  /** Draws the row with selected cells in selection colors. Selection never reshapes the row. */
  fun drawSelected(canvas: Canvas, row: Int, selection: TerminalSelection, paints: TerminalPaints) {
    drawContent(canvas, row, selection, paints)
  }

  fun release() {
    node?.discardDisplayList()
    node = null
  }

  private fun selected(row: Int, selection: TerminalSelection?, cell: Int): Boolean =
    selection?.contains(row, cellCol[cell], cellSpan[cell]) == true

  private fun drawContent(canvas: Canvas, row: Int, selection: TerminalSelection?, paints: TerminalPaints) {
    val cellWidth = font.cellWidthPx.toFloat()
    val cellHeight = font.cellHeightPx.toFloat()
    val fill = paints.fill
    for (cell in 0 until cellCount) {
      val background =
        if (selected(row, selection, cell)) paints.selectionBackground else cellBackground[cell]
      if (background ushr 24 == 0) continue
      fill.color = background
      canvas.drawRect(
        cellCol[cell] * cellWidth,
        0f,
        (cellCol[cell] + cellSpan[cell]) * cellWidth,
        cellHeight,
        fill,
      )
    }

    val baseline = font.baselinePx.toFloat()
    val text = measured
    if (text != null) {
      for (group in groups) {
        if (group.blank) continue
        val paint = font.paint(cellFlags[group.firstCell])
        var first = group.firstCell
        while (first <= group.lastCell) {
          val color = foreground(row, selection, first, paints)
          var last = first
          while (last < group.lastCell && foreground(row, selection, last + 1, paints) == color) last += 1
          // Only edges between differently colored cells clip; the group's outer edges may overhang.
          val clipped = first > group.firstCell || last < group.lastCell
          canvas.save()
          if (clipped) {
            val left = if (first > group.firstCell) cellCol[first] * cellWidth else -CLIP_UNBOUNDED_PX
            val right =
              if (last < group.lastCell) (cellCol[last] + cellSpan[last]) * cellWidth else CLIP_UNBOUNDED_PX
            canvas.clipRect(left, -CLIP_UNBOUNDED_PX, right, CLIP_UNBOUNDED_PX)
          }
          paint.color = color
          drawGroupText(canvas, text, group, paint, cellWidth, cellHeight, baseline)
          canvas.restore()
          first = last + 1
        }
      }
    }

    for (cell in 0 until cellCount) {
      val glyph = cellGlyph[cell]
      val flags = cellFlags[cell]
      val foreground = foreground(row, selection, cell, paints)
      if (glyph != null) {
        fill.color = foreground
        glyph.draw(canvas, cellCol[cell] * cellWidth, cellSpan[cell] * cellWidth, cellHeight, font.density, fill)
      }
      if (flags and (TerminalStyleFlags.UNDERLINE or TerminalStyleFlags.STRIKETHROUGH) == 0) continue
      fill.color = foreground
      val left = cellCol[cell] * cellWidth
      val right = left + cellSpan[cell] * cellWidth
      if (flags and TerminalStyleFlags.UNDERLINE != 0) {
        val top = baseline + font.underlineOffsetPx
        canvas.drawRect(left, top, right, top + font.underlineThicknessPx, fill)
      }
      if (flags and TerminalStyleFlags.STRIKETHROUGH != 0) {
        val top = baseline + font.strikeOffsetPx
        canvas.drawRect(left, top, right, top + font.strikeThicknessPx, fill)
      }
    }
  }

  private fun drawGroupText(
    canvas: Canvas,
    text: MeasuredText,
    group: Group,
    paint: Paint,
    cellWidth: Float,
    cellHeight: Float,
    baseline: Float,
  ) {
    val x = group.col * cellWidth + group.offsetPx
    if (group.scale < 1f) canvas.scale(group.scale, group.scale, x, cellHeight / 2f)
    canvas.drawTextRun(text, group.start, group.end, group.contextStart, group.contextEnd, x, baseline, false, paint)
  }

  private fun foreground(row: Int, selection: TerminalSelection?, cell: Int, paints: TerminalPaints): Int =
    if (selected(row, selection, cell)) paints.selectionForeground else cellForeground[cell]

  /** The row's text as accessibility reads it. */
  fun describe(): String = source.text.trimEnd()
}

/** Paint state shared by every row of one view. */
internal class TerminalPaints {
  val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  var selectionBackground: Int = 0xFFFFFF00.toInt()
  var selectionForeground: Int = 0xFF000000.toInt()
}
