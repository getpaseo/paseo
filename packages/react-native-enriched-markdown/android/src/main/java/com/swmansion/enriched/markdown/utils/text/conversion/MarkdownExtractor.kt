package com.swmansion.enriched.markdown.utils.text.conversion

import android.text.Spannable
import android.text.style.UnderlineSpan
import android.widget.TextView
import com.swmansion.enriched.markdown.EnrichedMarkdownText
import com.swmansion.enriched.markdown.spans.BaseListSpan
import com.swmansion.enriched.markdown.spans.BaselineShiftSpan
import com.swmansion.enriched.markdown.spans.BlockquoteSpan
import com.swmansion.enriched.markdown.spans.CodeBlockSpan
import com.swmansion.enriched.markdown.spans.CodeSpan
import com.swmansion.enriched.markdown.spans.EmphasisSpan
import com.swmansion.enriched.markdown.spans.HeadingSpan
import com.swmansion.enriched.markdown.spans.HighlightSpan
import com.swmansion.enriched.markdown.spans.ImageSpan
import com.swmansion.enriched.markdown.spans.LinkSpan
import com.swmansion.enriched.markdown.spans.OrderedListSpan
import com.swmansion.enriched.markdown.spans.StrikethroughSpan
import com.swmansion.enriched.markdown.spans.StrongSpan
import com.swmansion.enriched.markdown.spans.TaskListSpan
import com.swmansion.enriched.markdown.spans.ThematicBreakSpan
import com.swmansion.enriched.markdown.spans.UnorderedListSpan

/** Extracts markdown from styled text (Spannable). */
object MarkdownExtractor {
  /**
   * Gets markdown for the current text selection.
   * Full selection returns original markdown, partial reconstructs from spans.
   */
  fun getMarkdownForSelection(textView: TextView): String? {
    val start = textView.selectionStart
    val end = textView.selectionEnd
    if (start < 0 || end < 0 || start >= end) return null

    val spannable = textView.text as? Spannable ?: return null

    val isFullSelection = start == 0 && end >= textView.text.length - 1
    if (isFullSelection && textView is EnrichedMarkdownText) {
      val original = textView.currentMarkdown
      if (original.isNotEmpty()) return original
    }

    return extractFromSpannable(spannable, start, end)
  }

  /** Extracts markdown from a Spannable within a given range. */
  fun extractFromSpannable(
    spannable: Spannable,
    start: Int,
    end: Int,
  ): String {
    val result = StringBuilder()
    val state = ExtractionState()
    val headingAccumulator = HeadingAccumulator()

    var i = start
    while (i < end) {
      val nextTransition = spannable.nextSpanTransition(i, end, Any::class.java)
      val segmentText = spannable.subSequence(i, nextTransition).toString()

      val handled =
        processSegment(
          spannable = spannable,
          segmentText = segmentText,
          segmentStart = i,
          segmentEnd = nextTransition,
          result = result,
          state = state,
          headingAccumulator = headingAccumulator,
        )

      if (!handled) {
        // Regular text segment - apply inline formatting and block prefixes
        appendFormattedSegment(spannable, segmentText, i, nextTransition, result, state)
      }

      i = nextTransition
    }

    headingAccumulator.flush(result, state)
    return result.toString()
  }

  /** Returns true if segment was handled specially. */
  private fun processSegment(
    spannable: Spannable,
    segmentText: String,
    segmentStart: Int,
    segmentEnd: Int,
    result: StringBuilder,
    state: ExtractionState,
    headingAccumulator: HeadingAccumulator,
  ): Boolean {
    // Check for thematic breaks first (uses " \n" as placeholder)
    val thematicBreakSpans = spannable.getSpans(segmentStart, segmentEnd, ThematicBreakSpan::class.java)
    if (thematicBreakSpans.isNotEmpty()) {
      appendThematicBreak(result, state)
      return true
    }

    if (segmentText == "\uFFFC" || segmentText == "\u200B") {
      val imageSpans = spannable.getSpans(segmentStart, segmentEnd, ImageSpan::class.java)
      if (imageSpans.isNotEmpty()) {
        appendImage(imageSpans[0], result, state)
        return true
      }

      val mathLatex = extractMathLatex(spannable, segmentStart, segmentEnd)
      if (mathLatex != null) {
        result.append("$$mathLatex$")
        return true
      }
    }

    if (segmentText.isEmpty()) return true

    if (segmentText == "\n" || segmentText == "\n\n") {
      handleNewline(spannable, segmentStart, segmentEnd, result, state)
      return true
    }

    val headingSpans = spannable.getSpans(segmentStart, segmentEnd, HeadingSpan::class.java)
    if (headingSpans.isNotEmpty()) {
      headingAccumulator.accumulate(headingSpans[0].level, segmentText, result, state)
      return true
    } else {
      headingAccumulator.flush(result, state)
    }

    val codeBlockSpans = spannable.getSpans(segmentStart, segmentEnd, CodeBlockSpan::class.java)
    if (codeBlockSpans.isNotEmpty()) {
      appendCodeBlock(segmentText, result, state)
      return true
    }

    return false
  }

  private fun appendFormattedSegment(
    spannable: Spannable,
    segmentText: String,
    segmentStart: Int,
    segmentEnd: Int,
    result: StringBuilder,
    state: ExtractionState,
  ) {
    val blockquotePrefix = detectBlockquote(spannable, segmentStart, segmentEnd, state)
    val listPrefix = detectList(spannable, segmentStart, segmentEnd, state)
    var segment = applyInlineFormatting(spannable, segmentText, segmentStart, segmentEnd)

    if (result.isAtLineStart() && !segmentText.startsWith("\n")) {
      segment = buildBlockPrefix(blockquotePrefix, listPrefix) + segment
    }

    if (state.needsBlankLine && result.isNotEmpty()) {
      result.ensureBlankLine()
      state.needsBlankLine = false
    }

    result.append(segment)
  }

  private fun appendImage(
    img: ImageSpan,
    result: StringBuilder,
    state: ExtractionState,
  ) {
    if (img.isInline) {
      result.append("![image](${img.imageUrl})")
    } else {
      result.ensureBlankLine()
      result.append("![image](${img.imageUrl})\n")
      state.needsBlankLine = true
      state.blockquoteDepth = -1
      state.listDepth = -1
    }
  }

  private fun appendThematicBreak(
    result: StringBuilder,
    state: ExtractionState,
  ) {
    result.ensureBlankLine()
    result.append("---\n")
    state.needsBlankLine = true
    state.blockquoteDepth = -1
    state.listDepth = -1
  }

  private fun handleNewline(
    spannable: Spannable,
    start: Int,
    end: Int,
    result: StringBuilder,
    state: ExtractionState,
  ) {
    val inBlockquote = spannable.getSpans(start, end, BlockquoteSpan::class.java).isNotEmpty()
    val inList =
      spannable.getSpans(start, end, OrderedListSpan::class.java).isNotEmpty() ||
        spannable.getSpans(start, end, UnorderedListSpan::class.java).isNotEmpty() ||
        spannable.getSpans(start, end, TaskListSpan::class.java).isNotEmpty()

    when {
      !inBlockquote && state.blockquoteDepth >= 0 -> {
        result.ensureBlankLine()
        state.blockquoteDepth = -1
      }

      !inList && state.listDepth >= 0 -> {
        result.ensureBlankLine()
        state.listDepth = -1
      }

      inBlockquote || inList -> {
        if (!result.endsWith("\n")) result.append("\n")
      }

      else -> {
        result.ensureBlankLine()
      }
    }
  }

  private fun appendCodeBlock(
    text: String,
    result: StringBuilder,
    state: ExtractionState,
  ) {
    if (state.needsBlankLine) {
      result.ensureBlankLine()
      state.needsBlankLine = false
    }

    val needsFence = result.isEmpty() || result.endsWith("\n\n")
    if (needsFence) result.append("```\n")

    result.append(text)

    if (text.endsWith("\n")) {
      result.append("```\n")
      state.needsBlankLine = true
    }
  }

  private fun detectBlockquote(
    spannable: Spannable,
    start: Int,
    end: Int,
    state: ExtractionState,
  ): String? {
    val spans = spannable.getSpans(start, end, BlockquoteSpan::class.java)
    val depth = spans.maxOfOrNull { it.depth } ?: -1

    return if (depth >= 0) {
      state.blockquoteDepth = depth
      "> ".repeat(depth + 1)
    } else {
      if (state.blockquoteDepth >= 0) state.blockquoteDepth = -1
      null
    }
  }

  private fun detectList(
    spannable: Spannable,
    start: Int,
    end: Int,
    state: ExtractionState,
  ): String? {
    // A list item's span covers its nested children, so ancestors are returned here too. The
    // innermost span is the item this segment actually belongs to.
    val listSpan =
      spannable.getSpans(start, end, BaseListSpan::class.java).maxByOrNull { it.depth }

    if (listSpan == null) {
      if (state.listDepth >= 0) state.listDepth = -1
      return null
    }

    state.listDepth = listSpan.depth
    val indent = "  ".repeat(listSpan.depth)

    return when (listSpan) {
      is TaskListSpan -> "$indent- ${if (listSpan.isChecked) "[x]" else "[ ]"} "
      is OrderedListSpan -> "$indent${listSpan.itemNumber}. "
      else -> "$indent- "
    }
  }

  private fun applyInlineFormatting(
    spannable: Spannable,
    text: String,
    start: Int,
    end: Int,
  ): String {
    val hasStrong = spannable.getSpans(start, end, StrongSpan::class.java).isNotEmpty()
    val hasEmphasis = spannable.getSpans(start, end, EmphasisSpan::class.java).isNotEmpty()
    val hasCode = spannable.getSpans(start, end, CodeSpan::class.java).isNotEmpty()
    val hasStrikethrough = spannable.getSpans(start, end, StrikethroughSpan::class.java).isNotEmpty()
    val hasUnderline = spannable.getSpans(start, end, UnderlineSpan::class.java).isNotEmpty()
    val baselineShiftSpans = spannable.getSpans(start, end, BaselineShiftSpan::class.java)
    val hasSuperscript = baselineShiftSpans.any { it.spanType == BaselineShiftSpan.SpanType.SUPERSCRIPT }
    val hasSubscript = baselineShiftSpans.any { it.spanType == BaselineShiftSpan.SpanType.SUBSCRIPT }
    val linkSpans = spannable.getSpans(start, end, LinkSpan::class.java).filterNot { it.recognizedLink }
    val hasHighlight = spannable.getSpans(start, end, HighlightSpan::class.java).isNotEmpty()

    var result = text

    // Innermost first
    if (hasCode && linkSpans.isEmpty()) {
      result = "`$result`"
    }
    if (hasStrikethrough) {
      result = "~~$result~~"
    }
    if (hasSubscript) {
      result = "~$result~"
    }
    if (hasSuperscript) {
      result = "^$result^"
    }
    if (hasUnderline && linkSpans.isEmpty()) {
      result = "<u>$result</u>"
    }
    if (hasEmphasis) {
      result = "*$result*"
    }
    if (hasStrong) {
      result = "**$result**"
    }
    if (linkSpans.isNotEmpty()) {
      result = "[$result](${linkSpans[0].url})"
    }
    if (hasHighlight) {
      result = "==$result=="
    }

    return result
  }

  private fun buildBlockPrefix(
    blockquotePrefix: String?,
    listPrefix: String?,
  ): String =
    buildString {
      blockquotePrefix?.let { append(it) }
      listPrefix?.let { append(it) }
    }

  private data class ExtractionState(
    var blockquoteDepth: Int = -1,
    var listDepth: Int = -1,
    var needsBlankLine: Boolean = false,
  )

  /** Accumulates heading content across multiple span segments. */
  private class HeadingAccumulator {
    private var level: Int? = null
    private val content = StringBuilder()

    fun accumulate(
      newLevel: Int,
      text: String,
      result: StringBuilder,
      state: ExtractionState,
    ) {
      if (level != newLevel) {
        flush(result, state)
        level = newLevel
      }
      content.append(text.trim('\n'))
    }

    fun flush(
      result: StringBuilder,
      state: ExtractionState,
    ) {
      val currentLevel = level ?: return
      if (content.isEmpty()) return

      result.ensureBlankLine()
      result.append("#".repeat(currentLevel))
      result.append(" ")
      result.append(content.toString().trim())
      result.append("\n")

      level = null
      content.clear()
      state.needsBlankLine = true
    }
  }

  private fun StringBuilder.ensureBlankLine() {
    if (isEmpty() || endsWith("\n\n")) return
    append(if (endsWith("\n")) "\n" else "\n\n")
  }

  private fun StringBuilder.isAtLineStart(): Boolean = isEmpty() || endsWith("\n")

  private fun extractMathLatex(
    spannable: Spannable,
    start: Int,
    end: Int,
  ): String? {
    return try {
      val mathInlineSpanClass = Class.forName("com.swmansion.enriched.markdown.spans.MathInlineSpan")
      val spans = spannable.getSpans(start, end, mathInlineSpanClass)
      if (spans.isEmpty()) return null
      val latexField = mathInlineSpanClass.getDeclaredField("latex").apply { isAccessible = true }
      latexField.get(spans[0]) as? String
    } catch (_: Exception) {
      null
    }
  }
}
