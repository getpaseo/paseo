package sh.paseo.terminal

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class TerminalCursorRecord : Record {
  @Field val row: Int = 0
  @Field val col: Int = 0
}

class TerminalSelectionRecord : Record {
  @Field val startRow: Int = 0
  @Field val startCol: Int = 0
  @Field val endRow: Int = 0
  @Field val endCol: Int = 0
}

class TerminalFrameRecord : Record {
  @Field val columns: Int = 0
  /** Encoded rows, `cells;styles;text`; see `frame-encoding.ts`. */
  @Field val rows: List<String> = emptyList()
  @Field val cursor: TerminalCursorRecord? = null
  @Field val selection: TerminalSelectionRecord? = null
}

class TerminalThemeRecord : Record {
  @Field val background: Double = 0.0
  @Field val cursor: Double = 0.0
  @Field val selectionBackground: Double = 0.0
  @Field val selectionForeground: Double = 0.0
}

class TerminalCustomGlyphRecord : Record {
  @Field val char: String = ""
  @Field val rects: DoubleArray = DoubleArray(0)
  @Field val path: DoubleArray = DoubleArray(0)
  @Field val strokeWidth: Double = 0.0
}

internal object TerminalStyleFlags {
  const val BOLD = 1
  const val ITALIC = 2
  const val UNDERLINE = 4
  const val STRIKETHROUGH = 8
}

/** JS sends colors as unsigned ARGB numbers; Android paints signed ARGB ints. */
internal fun argb(value: Double): Int = value.toLong().toInt()

/** One row as the caller described it: cell text, column spans and style spans. */
internal class TerminalRowSource private constructor(
  val text: String,
  val cells: IntArray,
  val styles: DoubleArray,
) {
  companion object {
    /** Decodes `cells;styles;text`, where both number lists are comma separated. */
    fun decode(encoded: String): TerminalRowSource {
      val cellsEnd = encoded.indexOf(';')
      val stylesEnd = encoded.indexOf(';', cellsEnd + 1)
      val cells = parseNumbers(encoded, 0, cellsEnd)
      val styles = parseNumbers(encoded, cellsEnd + 1, stylesEnd)
      return TerminalRowSource(
        encoded.substring(stylesEnd + 1),
        IntArray(cells.size) { cells[it].toInt() },
        DoubleArray(styles.size) { styles[it].toDouble() },
      )
    }

    private fun parseNumbers(encoded: String, start: Int, end: Int): LongArray {
      if (end <= start) return LongArray(0)
      var count = 1
      for (index in start until end) if (encoded[index] == ',') count += 1
      val numbers = LongArray(count)
      var slot = 0
      for (index in start until end) {
        val char = encoded[index]
        if (char == ',') slot += 1 else numbers[slot] = numbers[slot] * 10 + (char - '0')
      }
      return numbers
    }
  }
}

internal class TerminalSelection(record: TerminalSelectionRecord) {
  private val startRow = record.startRow
  private val startCol = record.startCol
  private val endRow = record.endRow
  private val endCol = record.endCol

  fun intersectsRow(row: Int): Boolean = row in startRow..endRow

  /** A cell is selected when any column it covers is inside the inclusive range. */
  fun contains(row: Int, col: Int, span: Int): Boolean {
    if (!intersectsRow(row)) return false
    val firstCol = if (row == startRow) startCol else 0
    val lastCol = if (row == endRow) endCol else Int.MAX_VALUE
    return col + span - 1 >= firstCol && col <= lastCol
  }
}
