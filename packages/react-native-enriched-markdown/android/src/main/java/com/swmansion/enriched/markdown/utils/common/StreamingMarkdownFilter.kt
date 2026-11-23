package com.swmansion.enriched.markdown.utils.common

enum class TableStreamingMode {
  HIDDEN,
  PROGRESSIVE,
}

enum class CodeBlockStreamingMode {
  HIDDEN,
  PROGRESSIVE,
}

/**
 * Filtered markdown plus whether it ends inside a still-open fenced code block
 * (the trailing block whose highlighting/copy chrome the renderer defers).
 */
data class StreamingFilterResult(
  val markdown: String,
  val endsInsideOpenCodeFence: Boolean,
)

/**
 * Pre-parse filter that hides incomplete trailing tables, block math and code
 * blocks while streaming. An open fenced code block is handled first so its
 * body (which may hold `$$` or `|` lines) is not mistaken for a pending
 * math/table block: HIDDEN truncates it, PROGRESSIVE keeps it and only filters
 * the region before it. endsInsideOpenCodeFence flags that trailing open block.
 */
object StreamingMarkdownFilter {
  fun renderableMarkdownForStreaming(
    markdown: String,
    tableMode: TableStreamingMode = TableStreamingMode.PROGRESSIVE,
    codeBlockMode: CodeBlockStreamingMode = CodeBlockStreamingMode.PROGRESSIVE,
  ): StreamingFilterResult {
    val lines = markdown.split("\n")
    val openFenceIndex = findOpenCodeFenceLineIndex(lines)

    if (openFenceIndex == -1) {
      return StreamingFilterResult(removePendingTablesAndMath(markdown, tableMode, lines), false)
    }

    val fenceOffset = buildLineOffsets(lines)[openFenceIndex]
    val head = markdown.substring(0, fenceOffset)
    if (codeBlockMode == CodeBlockStreamingMode.HIDDEN) {
      return StreamingFilterResult(removePendingTablesAndMath(head, tableMode), false)
    }
    val tail = markdown.substring(fenceOffset)
    return StreamingFilterResult(removePendingTablesAndMath(head, tableMode) + tail, true)
  }

  private fun removePendingTablesAndMath(
    markdown: String,
    tableMode: TableStreamingMode,
    lines: List<String> = markdown.split("\n"),
  ): String {
    val afterMath = removePendingStreamingMathBlock(markdown, lines)
    val linesForTable = if (afterMath.length == markdown.length) lines else afterMath.split("\n")
    return removePendingStreamingTableBlock(afterMath, linesForTable, tableMode)
  }

  private class FenceMarker(
    val char: Char,
    val length: Int,
    val info: String,
  )

  private fun parseFenceMarker(line: String): FenceMarker? {
    var i = 0
    while (i < line.length && line[i] == ' ' && i < 3) i++
    if (i >= line.length) return null
    val ch = line[i]
    if (ch != '`' && ch != '~') return null
    var runLength = 0
    while (i < line.length && line[i] == ch) {
      i++
      runLength++
    }
    if (runLength < 3) return null
    val info = line.substring(i)
    if (ch == '`' && info.contains('`')) return null
    return FenceMarker(ch, runLength, info)
  }

  private fun findOpenCodeFenceLineIndex(lines: List<String>): Int {
    var openIndex = -1
    var openChar = ' '
    var openLength = 0
    for (i in lines.indices) {
      val marker = parseFenceMarker(lines[i])
      if (openIndex == -1) {
        if (marker != null) {
          openIndex = i
          openChar = marker.char
          openLength = marker.length
        }
      } else if (marker != null && marker.char == openChar && marker.length >= openLength && marker.info.isBlank()) {
        openIndex = -1
      }
    }
    return openIndex
  }

  private fun removePendingStreamingMathBlock(
    markdown: String,
    lines: List<String>,
  ): String {
    var lastUnclosedDelimiterIndex = -1

    for (i in lines.indices) {
      if (lineIsBlockMathDelimiter(lines[i])) {
        lastUnclosedDelimiterIndex = if (lastUnclosedDelimiterIndex == -1) i else -1
      }
    }

    if (lastUnclosedDelimiterIndex == -1) return markdown

    val offsets = buildLineOffsets(lines)
    return markdown.substring(0, offsets[lastUnclosedDelimiterIndex])
  }

  private fun removePendingStreamingTableBlock(
    markdown: String,
    lines: List<String>,
    tableMode: TableStreamingMode,
  ): String {
    var lastNonBlankLineIndex = -1

    for (i in lines.indices.reversed()) {
      if (!lineIsBlank(lines[i])) {
        lastNonBlankLineIndex = i
        break
      }
    }

    if (lastNonBlankLineIndex == -1) return markdown

    if (lastNonBlankLineIndex + 1 < lines.size - 1) return markdown

    var blockStartIndex = lastNonBlankLineIndex
    while (blockStartIndex > 0 && !lineIsBlank(lines[blockStartIndex - 1])) {
      blockStartIndex--
    }

    var blockLooksLikeTable = false
    for (i in blockStartIndex..lastNonBlankLineIndex) {
      if (!lineLooksLikeTableRow(lines[i])) return markdown
      blockLooksLikeTable = true
    }

    if (!blockLooksLikeTable) return markdown

    val offsets = buildLineOffsets(lines)

    if (tableMode == TableStreamingMode.PROGRESSIVE) {
      val tableLineCount = lastNonBlankLineIndex - blockStartIndex + 1

      if (tableLineCount < 2 || !lineLooksLikeTableSeparator(lines[blockStartIndex + 1])) {
        return markdown.substring(0, offsets[blockStartIndex])
      }

      if (tableLineCount > 2) {
        val lastRow = lines[lastNonBlankLineIndex]
        val lastRowTrimmed = lastRow.trim()
        val headerRow = lines[blockStartIndex]
        if (!lastRowTrimmed.endsWith("|") || pipeCount(lastRow) < pipeCount(headerRow)) {
          return markdown.substring(0, offsets[lastNonBlankLineIndex])
        }
      }

      return markdown
    }

    return markdown.substring(0, offsets[blockStartIndex])
  }

  private fun lineIsBlank(line: String): Boolean = line.isBlank()

  private fun lineIsBlockMathDelimiter(line: String): Boolean = line.trim() == "$$"

  private fun lineLooksLikeTableRow(line: String): Boolean {
    val trimmed = line.trim()
    return trimmed.startsWith("|")
  }

  private fun lineLooksLikeTableSeparator(line: String): Boolean {
    val trimmed = line.trim()
    if (trimmed.isEmpty()) return false
    if (trimmed[0] != '|') return false
    var hasTripleDash = false
    var dashRun = 0
    for (ch in trimmed) {
      if (ch == '-') {
        dashRun++
        if (dashRun >= 3) hasTripleDash = true
      } else {
        dashRun = 0
        if (ch != '|' && ch != ':' && ch != ' ') return false
      }
    }
    return hasTripleDash
  }

  private fun pipeCount(line: String): Int {
    var count = 0
    for (ch in line) {
      if (ch == '|') count++
    }
    return count
  }

  private fun buildLineOffsets(lines: List<String>): IntArray {
    val offsets = IntArray(lines.size)
    var currentOffset = 0
    for (i in lines.indices) {
      offsets[i] = currentOffset
      currentOffset += lines[i].length + 1
    }
    return offsets
  }
}
