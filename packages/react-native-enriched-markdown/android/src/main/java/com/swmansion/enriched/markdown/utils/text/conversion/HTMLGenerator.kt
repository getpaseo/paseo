package com.swmansion.enriched.markdown.utils.text.conversion

import android.graphics.Typeface
import android.text.Layout
import android.text.Spannable
import android.text.style.StyleSpan
import android.text.style.UnderlineSpan
import com.swmansion.enriched.markdown.spans.BaseListSpan
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
import com.swmansion.enriched.markdown.spans.UnorderedListSpan
import com.swmansion.enriched.markdown.styles.StyleConfig

/** Generates semantic HTML with inline styles from Spannable text. */
object HTMLGenerator {
  private const val OBJECT_REPLACEMENT_CHAR = '\uFFFC'

  /** Pre-computed styles to avoid repeated StyleConfig method calls. */
  private class CachedStyles(
    style: StyleConfig,
    private val fontDensity: Float,
    private val dimDensity: Float,
  ) {
    // Convert device pixels back to CSS pixels
    private fun fontPx(px: Float) = (px / fontDensity).toInt()

    private fun dimPx(px: Float) = (px / dimDensity).toInt()

    // Paragraph
    val paragraphColor: String
    val paragraphFontSize: Int
    val paragraphMarginBottom: Int

    // Code block
    val codeBlockColor: String
    val codeBlockBgColor: String
    val codeBlockFontSize: Int
    val codeBlockPadding: Int
    val codeBlockBorderRadius: Int
    val codeBlockMarginBottom: Int

    // Inline code
    val codeColor: String
    val codeBgColor: String

    // Blockquote
    val blockquoteColor: String
    val blockquoteBgColor: String
    val blockquoteBorderColor: String
    val blockquoteBorderWidth: Int
    val blockquoteGapWidth: Int
    val blockquoteMarginBottom: Int
    val blockquoteFontSize: Int

    // List
    val listColor: String
    val listFontSize: Int
    val listMarginBottom: Int
    val listMarginLeft: Int

    // Task list checkbox
    val taskCheckedColor: String
    val taskBorderColor: String
    val taskCheckmarkColor: String
    val taskCheckboxSize: Int
    val taskCheckboxBorderRadius: Int

    // Link
    val linkFontFamily: String
    val linkColor: String
    val linkUnderline: Boolean

    // Strong/Emphasis/Strikethrough/Underline
    val strongColor: String?
    val emphasisColor: String?
    val strikethroughColor: String?
    val underlineColor: String?
    val highlightColor: String
    val highlightBackgroundColor: String

    // Image
    val imageMarginBottom: Int
    val imageBorderRadius: Int

    // Fixed HTML values (not from StyleConfig)
    val blockquotePaddingVertical = "8px"
    val blockquoteBorderRadiusCorners = "border-start-end-radius: 8px; border-end-end-radius: 8px"
    val blockquoteNestedMargin = "8px 0 0 0"
    val blockquoteParagraphMargin = "0 0 4px 0"
    val inlineImageHeight = "1.2em"
    val inlineImageVerticalAlign = "-0.2em"
    val codePadding = "2px 4px"
    val codeBorderRadius = "4px"
    val codeFontSize = "1em"

    // Headings (array for O(1) lookup)
    val headingFontSizes: IntArray
    val headingFontWeights: Array<String>
    val headingColors: Array<String>
    val headingMarginBottoms: IntArray

    init {
      // Paragraph
      val pStyle = style.paragraphStyle
      paragraphColor = colorToCSS(pStyle.color)
      paragraphFontSize = fontPx(pStyle.fontSize)
      paragraphMarginBottom = dimPx(pStyle.marginBottom)

      // Code block
      val cbStyle = style.codeBlockStyle
      codeBlockColor = colorToCSS(cbStyle.color)
      codeBlockBgColor = colorToCSS(cbStyle.backgroundColor)
      codeBlockFontSize = fontPx(cbStyle.fontSize)
      codeBlockPadding = dimPx(cbStyle.padding)
      codeBlockBorderRadius = dimPx(cbStyle.borderRadius)
      codeBlockMarginBottom = dimPx(cbStyle.marginBottom)

      // Inline code
      val cStyle = style.codeStyle
      codeColor = colorToCSS(cStyle.color)
      codeBgColor = colorToCSS(cStyle.backgroundColor)

      // Blockquote
      val bqStyle = style.blockquoteStyle
      blockquoteColor = colorToCSS(bqStyle.color)
      blockquoteBgColor = colorToCSS(bqStyle.backgroundColor ?: 0)
      blockquoteBorderColor = colorToCSS(bqStyle.borderColor)
      blockquoteBorderWidth = dimPx(bqStyle.borderWidth)
      blockquoteGapWidth = dimPx(bqStyle.gapWidth)
      blockquoteMarginBottom = dimPx(bqStyle.marginBottom)
      blockquoteFontSize = fontPx(bqStyle.fontSize)

      // List
      val lStyle = style.listStyle
      listColor = colorToCSS(lStyle.color)
      listFontSize = fontPx(lStyle.fontSize)
      listMarginBottom = dimPx(lStyle.marginBottom)
      listMarginLeft = dimPx(lStyle.marginLeft)

      // Task list checkbox
      val tlStyle = style.taskListStyle
      taskCheckedColor = colorToCSS(tlStyle.checkedColor)
      taskBorderColor = colorToCSS(tlStyle.borderColor)
      taskCheckmarkColor = colorToCSS(tlStyle.checkmarkColor)
      taskCheckboxSize = dimPx(tlStyle.checkboxSize)
      taskCheckboxBorderRadius = dimPx(tlStyle.checkboxBorderRadius)

      // Link
      linkFontFamily = style.linkStyle.fontFamily
      linkColor = colorToCSS(style.linkStyle.color)
      linkUnderline = style.linkStyle.underline

      // Strong/Emphasis/Strikethrough/Underline (nullable for inherit)
      val sc = style.strongStyle.color
      strongColor = if (sc != null && sc != 0) colorToCSS(sc) else null
      val ec = style.emphasisStyle.color
      emphasisColor = if (ec != null && ec != 0) colorToCSS(ec) else null
      val strikeColor = style.strikethroughStyle.color
      strikethroughColor = if (strikeColor != 0) colorToCSS(strikeColor) else null
      val underline = style.underlineStyle.color
      underlineColor = if (underline != 0) colorToCSS(underline) else null
      highlightColor = colorToCSS(style.highlightStyle.color)
      highlightBackgroundColor = colorToCSS(style.highlightStyle.backgroundColor)

      // Image
      val imgStyle = style.imageStyle
      imageMarginBottom = dimPx(imgStyle.marginBottom)
      imageBorderRadius = dimPx(imgStyle.borderRadius)

      // Headings (1-6, index 0-5)
      headingFontSizes = IntArray(6)
      headingFontWeights = Array(6) { "" }
      headingColors = Array(6) { "" }
      headingMarginBottoms = IntArray(6)

      for (level in 1..6) {
        val hStyle = style.headingStyles[level]!!
        val idx = level - 1
        headingFontSizes[idx] = fontPx(hStyle.fontSize)
        headingFontWeights[idx] = fontWeightToCSS(hStyle.fontWeight)
        headingColors[idx] = colorToCSS(hStyle.color)
        headingMarginBottoms[idx] = dimPx(hStyle.marginBottom)
      }
    }

    companion object {
      private fun colorToCSS(color: Int): String {
        if (color == 0) return "inherit"
        val alpha = (color shr 24) and 0xFF
        val red = (color shr 16) and 0xFF
        val green = (color shr 8) and 0xFF
        val blue = color and 0xFF

        return if (alpha < 255) {
          "rgba($red, $green, $blue, ${alpha / 255f})"
        } else {
          String.format("#%02X%02X%02X", red, green, blue)
        }
      }

      fun fontWeightToCSS(fontWeight: String): String =
        when {
          fontWeight.equals("bold", ignoreCase = true) -> "700"
          fontWeight.equals("semibold", ignoreCase = true) -> "600"
          fontWeight.equals("medium", ignoreCase = true) -> "500"
          fontWeight.isEmpty() || fontWeight.equals("normal", ignoreCase = true) -> "normal"
          else -> fontWeight
        }
    }
  }

  private class GeneratorState {
    var inCodeBlock = false
    var previousWasCodeBlock = false
    val codeBlockLines = ArrayList<String>(16) // Pre-sized

    var inBlockquote = false
    var blockquoteDepth = -1
    var previousWasBlockquote = false

    var listDepth = -1
    val openListTypes = ArrayList<Boolean>(4) // true = ol, false = ul
  }

  // Paragraph type constants (H1-H6 = 1-6 directly from HeadingSpan.level)
  private const val TYPE_NORMAL = 0
  private const val TYPE_H1 = 1
  private const val TYPE_H6 = 6
  private const val TYPE_CODE_BLOCK = 7
  private const val TYPE_BLOCKQUOTE = 8
  private const val TYPE_ORDERED_LIST = 9
  private const val TYPE_UNORDERED_LIST = 10
  private const val TYPE_TASK_LIST = 11

  private data class ParagraphInfo(
    val start: Int,
    val end: Int,
    val type: Int,
    val depth: Int = 0,
    val isTaskChecked: Boolean = false,
  )

  fun generateHTML(
    text: Spannable,
    style: StyleConfig,
    scaledDensity: Float = 1f,
    density: Float = 1f,
    isRTL: Boolean = false,
  ): String {
    if (text.isEmpty()) return "<html></html>"

    // Pre-cache all styles (single allocation)
    val styles = CachedStyles(style, scaledDensity, density)
    val state = GeneratorState()

    // Estimate capacity (average 2x text length)
    val html = StringBuilder(text.length * 2)
    if (isRTL) {
      html.append("<html dir=\"rtl\">")
      html.append("<div dir=\"rtl\" style=\"direction: rtl; text-align: right;\">")
    } else {
      html.append("<html>")
    }

    // Collect paragraphs
    val paragraphs = collectParagraphs(text)

    for (para in paragraphs) {
      processParagraph(html, text, para, styles, state)
    }

    closeRemainingContainers(html, state, styles)
    if (isRTL) {
      html.append("</div>")
    }
    html.append("</html>")

    return html.toString()
  }

  private fun processParagraph(
    html: StringBuilder,
    text: Spannable,
    para: ParagraphInfo,
    styles: CachedStyles,
    state: GeneratorState,
  ) {
    val paraText = text.subSequence(para.start, para.end).toString().trimEnd('\n')

    // Handle empty paragraphs
    if (paraText.isEmpty() && para.type == TYPE_NORMAL) {
      closeAllBlockquotes(html, state)
      state.previousWasBlockquote = false
      return
    }

    // Get content range (trim trailing newline)
    val contentEnd = if (para.end > para.start && text[para.end - 1] == '\n') para.end - 1 else para.end
    val isCodeBlock = para.type == TYPE_CODE_BLOCK
    val inlineContent = generateInlineHTML(text, para.start, contentEnd, styles, isCodeBlock)

    // Handle different paragraph types
    when (para.type) {
      TYPE_CODE_BLOCK -> handleCodeBlock(inlineContent, state)
      TYPE_BLOCKQUOTE -> handleBlockquote(html, inlineContent, para, styles, state)
      TYPE_ORDERED_LIST, TYPE_UNORDERED_LIST, TYPE_TASK_LIST -> handleList(html, inlineContent, para, styles, state)
      in TYPE_H1..TYPE_H6 -> handleHeading(html, inlineContent, para.type, styles, state)
      else -> handleNormalParagraph(html, inlineContent, styles, state)
    }
  }

  private fun handleCodeBlock(
    content: String,
    state: GeneratorState,
  ) {
    if (!state.inCodeBlock) {
      state.inCodeBlock = true
      state.codeBlockLines.clear()
    }

    state.codeBlockLines.add(content.trimStart())
    state.previousWasCodeBlock = true
    state.previousWasBlockquote = false
  }

  private fun outputCodeBlock(
    html: StringBuilder,
    lines: List<String>,
    styles: CachedStyles,
  ) {
    if (lines.isEmpty()) return

    html
      .append("<pre dir=\"ltr\" style=\"background-color: ")
      .append(styles.codeBlockBgColor)
      .append("; padding: ")
      .append(styles.codeBlockPadding)
      .append("px; border-radius: ")
      .append(styles.codeBlockBorderRadius)
      .append("px; margin: 0 0 ")
      .append(styles.codeBlockMarginBottom)
      .append("px 0; overflow-x: auto; text-align: left;\"><code style=\"font-family: Menlo, Monaco, Consolas, monospace; font-size: ")
      .append(styles.codeBlockFontSize)
      .append("px; color: ")
      .append(styles.codeBlockColor)
      .append(";\">")

    for (i in lines.indices) {
      if (i > 0) html.append('\n')
      html.append(lines[i])
    }

    html.append("</code></pre>")
  }

  private fun handleBlockquote(
    html: StringBuilder,
    content: String,
    para: ParagraphInfo,
    styles: CachedStyles,
    state: GeneratorState,
  ) {
    closeCodeBlockIfOpen(html, state, styles)

    val depth = para.depth

    // Reset if coming from non-blockquote content
    if (!state.previousWasBlockquote && state.inBlockquote) {
      closeAllBlockquotes(html, state)
    }

    while (state.blockquoteDepth > depth) {
      html.append("</blockquote>")
      state.blockquoteDepth--
    }

    while (state.blockquoteDepth < depth) {
      state.blockquoteDepth++
      state.inBlockquote = true

      if (state.blockquoteDepth == 0) {
        html
          .append("<blockquote style=\"background-color: ")
          .append(styles.blockquoteBgColor)
          .append("; border-inline-start: ")
          .append(styles.blockquoteBorderWidth)
          .append("px solid ")
          .append(styles.blockquoteBorderColor)
          .append("; padding: ")
          .append(styles.blockquotePaddingVertical)
          .append(" ")
          .append(styles.blockquoteGapWidth)
          .append("px; margin: 0 0 ")
          .append(styles.blockquoteMarginBottom)
          .append("px 0; ")
          .append(styles.blockquoteBorderRadiusCorners)
          .append(";\">")
      } else {
        html
          .append("<blockquote style=\"border-inline-start: ")
          .append(styles.blockquoteBorderWidth)
          .append("px solid ")
          .append(styles.blockquoteBorderColor)
          .append("; padding-inline-start: ")
          .append(styles.blockquoteGapWidth)
          .append("px; margin: ")
          .append(styles.blockquoteNestedMargin)
          .append(";\">")
      }
    }

    html
      .append("<p style=\"margin: ")
      .append(styles.blockquoteParagraphMargin)
      .append("; color: ")
      .append(styles.blockquoteColor)
      .append("; font-size: ")
      .append(styles.blockquoteFontSize)
      .append("px;\">")
      .append(content)
      .append("</p>")

    state.previousWasBlockquote = true
    state.previousWasCodeBlock = false
  }

  private fun handleList(
    html: StringBuilder,
    content: String,
    para: ParagraphInfo,
    styles: CachedStyles,
    state: GeneratorState,
  ) {
    closeCodeBlockIfOpen(html, state, styles)
    closeAllBlockquotes(html, state)

    val depth = para.depth
    val isOrdered = para.type == TYPE_ORDERED_LIST
    val isTask = para.type == TYPE_TASK_LIST

    // Close lists to shallower depth
    while (state.listDepth > depth) {
      html.append(if (state.openListTypes.lastOrNull() == true) "</ol>" else "</ul>")
      if (state.openListTypes.isNotEmpty()) state.openListTypes.removeAt(state.openListTypes.lastIndex)
      state.listDepth--
    }

    // Handle list type change at same depth (ul <-> ol)
    if (state.listDepth == depth && state.openListTypes.isNotEmpty()) {
      if (state.openListTypes.last() != isOrdered) {
        html.append(if (state.openListTypes.last()) "</ol>" else "</ul>")
        state.openListTypes.removeAt(state.openListTypes.lastIndex)
        state.listDepth--
      }
    }

    // Open lists to deeper depth
    while (state.listDepth < depth) {
      state.listDepth++
      val marginStyle =
        if (state.listDepth == 0) {
          "margin: 0 0 ${styles.paragraphMarginBottom}px 0; "
        } else {
          "margin: 0; "
        }

      if (isOrdered) {
        html
          .append("<ol style=\"")
          .append(marginStyle)
          .append("padding-inline-start: ")
          .append(styles.listMarginLeft)
          .append("px;\">")
        state.openListTypes.add(true)
      } else {
        html
          .append("<ul style=\"")
          .append(marginStyle)
          .append("padding-inline-start: ")
          .append(styles.listMarginLeft)
          .append("px; list-style-type: disc;\">")
        state.openListTypes.add(false)
      }
    }

    html
      .append("<li style=\"margin-bottom: ")
      .append(styles.listMarginBottom)
      .append("px; color: ")
      .append(styles.listColor)
      .append("; font-size: ")
      .append(styles.listFontSize)
      .append("px;")

    if (isTask) {
      html.append(" list-style-type: none;")
    }

    html.append("\">")

    if (isTask) {
      val size = styles.taskCheckboxSize
      val radius = styles.taskCheckboxBorderRadius
      if (para.isTaskChecked) {
        html
          .append("<span style=\"display: inline-block; width: ")
          .append(size)
          .append("px; height: ")
          .append(size)
          .append("px; border-radius: ")
          .append(radius)
          .append("px; background-color: ")
          .append(styles.taskCheckedColor)
          .append("; color: ")
          .append(styles.taskCheckmarkColor)
          .append("; font-size: ")
          .append(size - 2)
          .append("px; line-height: ")
          .append(size)
          .append("px; text-align: center; vertical-align: middle; margin-inline-end: 4px;\">&#10003;</span> ")
      } else {
        html
          .append("<span style=\"display: inline-block; width: ")
          .append(size)
          .append("px; height: ")
          .append(size)
          .append("px; border-radius: ")
          .append(radius)
          .append("px; border: 1.5px solid ")
          .append(styles.taskBorderColor)
          .append("; vertical-align: middle; margin-inline-end: 4px;\"></span> ")
      }
    }

    html
      .append(content)
      .append("</li>")

    state.previousWasBlockquote = false
    state.previousWasCodeBlock = false
  }

  private fun handleHeading(
    html: StringBuilder,
    content: String,
    type: Int,
    styles: CachedStyles,
    state: GeneratorState,
  ) {
    closeCodeBlockIfOpen(html, state, styles)
    closeAllBlockquotes(html, state)
    closeListsIfOpen(html, state)

    val level = type // TYPE_H1..TYPE_H6 = 1..6
    val idx = level - 1

    html
      .append("<h")
      .append(level)
      .append(" style=\"font-size: ")
      .append(styles.headingFontSizes[idx])
      .append("px; font-weight: ")
      .append(styles.headingFontWeights[idx])
      .append("; color: ")
      .append(styles.headingColors[idx])
      .append("; margin: 0 0 ")
      .append(styles.headingMarginBottoms[idx])
      .append("px 0;\">")
      .append(content)
      .append("</h")
      .append(level)
      .append('>')

    state.previousWasBlockquote = false
    state.previousWasCodeBlock = false
  }

  private fun handleNormalParagraph(
    html: StringBuilder,
    content: String,
    styles: CachedStyles,
    state: GeneratorState,
  ) {
    closeCodeBlockIfOpen(html, state, styles)
    closeAllBlockquotes(html, state)
    closeListsIfOpen(html, state)

    html
      .append("<p style=\"margin: 0 0 ")
      .append(styles.paragraphMarginBottom)
      .append("px 0; color: ")
      .append(styles.paragraphColor)
      .append("; font-size: ")
      .append(styles.paragraphFontSize)
      .append("px;\">")
      .append(content)
      .append("</p>")

    state.previousWasBlockquote = false
    state.previousWasCodeBlock = false
  }

  private fun closeCodeBlockIfOpen(
    html: StringBuilder,
    state: GeneratorState,
    styles: CachedStyles,
  ) {
    if (state.inCodeBlock) {
      state.inCodeBlock = false
      outputCodeBlock(html, state.codeBlockLines, styles)
      state.codeBlockLines.clear()
    }
  }

  private fun closeAllBlockquotes(
    html: StringBuilder,
    state: GeneratorState,
  ) {
    while (state.blockquoteDepth >= 0) {
      html.append("</blockquote>")
      state.blockquoteDepth--
    }
    state.inBlockquote = false
  }

  private fun closeListsIfOpen(
    html: StringBuilder,
    state: GeneratorState,
  ) {
    while (state.openListTypes.isNotEmpty()) {
      html.append(if (state.openListTypes.last()) "</ol>" else "</ul>")
      state.openListTypes.removeAt(state.openListTypes.lastIndex)
    }
    state.listDepth = -1
  }

  private fun closeRemainingContainers(
    html: StringBuilder,
    state: GeneratorState,
    styles: CachedStyles,
  ) {
    closeCodeBlockIfOpen(html, state, styles)
    closeAllBlockquotes(html, state)
    closeListsIfOpen(html, state)
  }

  private fun generateInlineHTML(
    text: Spannable,
    start: Int,
    end: Int,
    styles: CachedStyles,
    isCodeBlock: Boolean,
  ): String {
    val html = StringBuilder(end - start + 32)
    var i = start

    while (i < end) {
      val char = text[i]

      when {
        char == '\n' && i == end - 1 -> {
          i++
        }

        char == OBJECT_REPLACEMENT_CHAR -> {
          appendReplacementChar(html, text, i, styles)
          i++
        }

        else -> {
          val segmentEnd = minOf(text.nextSpanTransition(i, end, Any::class.java), end)
          val segmentText = text.subSequence(i, segmentEnd).toString()

          if (segmentText.isNotEmpty() && segmentText != "\n") {
            appendStyledSegment(html, text, i, segmentEnd, segmentText, styles, isCodeBlock)
          }
          i = segmentEnd
        }
      }
    }

    return html.toString()
  }

  private fun appendReplacementChar(
    html: StringBuilder,
    text: Spannable,
    pos: Int,
    styles: CachedStyles,
  ) {
    val imageSpans = text.getSpans(pos, pos + 1, ImageSpan::class.java)
    if (imageSpans.isNotEmpty()) {
      val imgSpan = imageSpans[0]

      if (imgSpan.isInline) {
        html.append("<img src=\"")
        escapeHTMLTo(html, imgSpan.imageUrl)
        html
          .append("\" style=\"height: ")
          .append(styles.inlineImageHeight)
          .append("; width: auto; vertical-align: ")
          .append(styles.inlineImageVerticalAlign)
          .append(";\">")
      } else {
        html
          .append("</p><div style=\"margin-bottom: ")
          .append(styles.imageMarginBottom)
          .append("px;\"><img src=\"")
        escapeHTMLTo(html, imgSpan.imageUrl)
        html
          .append("\" style=\"max-width: 100%; border-radius: ")
          .append(styles.imageBorderRadius)
          .append("px;\"></div><p>")
      }
      return
    }

    val mathLatex = extractMathLatex(text, pos, pos + 1)
    if (mathLatex != null) {
      html
        .append("<code style=\"background-color: ")
        .append(styles.codeBgColor)
        .append("; color: ")
        .append(styles.codeColor)
        .append("; padding: ")
        .append(styles.codePadding)
        .append("; border-radius: ")
        .append(styles.codeBorderRadius)
        .append("; font-size: ")
        .append(styles.codeFontSize)
        .append("; font-family: Menlo, Monaco, Consolas, monospace;\">")
      escapeHTMLTo(html, mathLatex)
      html.append("</code>")
    }
  }

  private fun appendStyledSegment(
    html: StringBuilder,
    text: Spannable,
    start: Int,
    end: Int,
    content: String,
    styles: CachedStyles,
    isCodeBlock: Boolean,
  ) {
    val strongSpans = text.getSpans(start, end, StrongSpan::class.java)
    val styleSpans = text.getSpans(start, end, StyleSpan::class.java)
    val emphasisSpans = text.getSpans(start, end, EmphasisSpan::class.java)
    val underlineSpans = text.getSpans(start, end, UnderlineSpan::class.java)
    val strikethroughSpans = text.getSpans(start, end, StrikethroughSpan::class.java)
    val linkSpans = text.getSpans(start, end, LinkSpan::class.java)
    val codeSpans = text.getSpans(start, end, CodeSpan::class.java)
    val highlightSpans = text.getSpans(start, end, HighlightSpan::class.java)

    val isBold =
      strongSpans.isNotEmpty() ||
        styleSpans.any { it.style == Typeface.BOLD || it.style == Typeface.BOLD_ITALIC }
    val isItalic =
      emphasisSpans.isNotEmpty() ||
        styleSpans.any { it.style == Typeface.ITALIC || it.style == Typeface.BOLD_ITALIC }
    val isUnderline = underlineSpans.isNotEmpty()
    val isStrikethrough = strikethroughSpans.isNotEmpty()
    val link = linkSpans.firstOrNull()
    val isCode = codeSpans.isNotEmpty() && !isCodeBlock
    val isHighlight = highlightSpans.isNotEmpty()

    if (isHighlight) {
      html
        .append("<mark style=\"background-color: ")
        .append(styles.highlightBackgroundColor)
      if (styles.highlightColor != styles.paragraphColor) {
        html
          .append("; color: ")
          .append(styles.highlightColor)
      } else {
        html.append("; color: inherit")
      }
      html.append(";\">")
    }

    link?.let {
      html.append("<a href=\"")
      escapeHTMLTo(html, it.url)
      html
        .append("\" style=\"color: ")
        .append(styles.linkColor)
        .append("; text-decoration: ")
        .append(if (styles.linkUnderline) "underline" else "none")
      if (styles.linkFontFamily.isNotEmpty()) {
        html.append("; font-family: '").append(styles.linkFontFamily).append("'")
      }
      html.append(";\">")
    }

    if (isCode) {
      html
        .append("<code style=\"background-color: ")
        .append(styles.codeBgColor)
        .append("; color: ")
        .append(styles.codeColor)
        .append("; padding: ")
        .append(styles.codePadding)
        .append("; border-radius: ")
        .append(styles.codeBorderRadius)
        .append("; font-size: ")
        .append(styles.codeFontSize)
        .append("; font-family: Menlo, Monaco, Consolas, monospace;\">")
    }

    if (isBold) {
      if (styles.strongColor != null) {
        html.append("<strong style=\"color: ").append(styles.strongColor).append(";\">")
      } else {
        html.append("<strong>")
      }
    }

    if (isItalic) {
      if (styles.emphasisColor != null) {
        html.append("<em style=\"color: ").append(styles.emphasisColor).append(";\">")
      } else {
        html.append("<em>")
      }
    }

    if (isStrikethrough) {
      if (styles.strikethroughColor != null) {
        html.append("<s style=\"text-decoration-color: ").append(styles.strikethroughColor).append(";\">")
      } else {
        html.append("<s>")
      }
    }
    if (isUnderline && link == null) {
      if (styles.underlineColor != null) {
        html.append("<u style=\"text-decoration-color: ").append(styles.underlineColor).append(";\">")
      } else {
        html.append("<u>")
      }
    }

    escapeHTMLTo(html, content.trimEnd('\n'))

    if (isUnderline && link == null) html.append("</u>")
    if (isStrikethrough) html.append("</s>")
    if (isItalic) html.append("</em>")
    if (isBold) html.append("</strong>")
    if (isCode) html.append("</code>")
    if (link != null) html.append("</a>")
    if (isHighlight) html.append("</mark>")
  }

  private fun collectParagraphs(text: Spannable): ArrayList<ParagraphInfo> {
    val string = text.toString()
    val paragraphs = ArrayList<ParagraphInfo>(string.length / 40 + 1) // Estimate
    var currentIndex = 0

    while (currentIndex < string.length) {
      var lineEnd = string.indexOf('\n', currentIndex)
      if (lineEnd == -1) lineEnd = string.length else lineEnd++

      val listSpan = innermostListSpan(text, currentIndex)
      val type = getParagraphType(text, currentIndex, listSpan)
      val depth = getDepthForType(text, currentIndex, type, listSpan)
      val isTaskChecked = type == TYPE_TASK_LIST && (listSpan as? TaskListSpan)?.isChecked == true

      paragraphs.add(ParagraphInfo(currentIndex, lineEnd, type, depth, isTaskChecked))
      currentIndex = lineEnd
    }

    return paragraphs
  }

  /**
   * The list span that owns the line starting at [start]. A list item's span covers its nested
   * children, so every ancestor is returned here as well - the innermost span is the item that
   * actually starts on this line.
   */
  private fun innermostListSpan(
    text: Spannable,
    start: Int,
  ): BaseListSpan? =
    text
      .getSpans(start, minOf(start + 1, text.length), BaseListSpan::class.java)
      .maxByOrNull { it.depth }

  private fun getParagraphType(
    text: Spannable,
    start: Int,
    listSpan: BaseListSpan?,
  ): Int {
    val end = minOf(start + 1, text.length)

    if (text.getSpans(start, end, CodeBlockSpan::class.java).isNotEmpty()) return TYPE_CODE_BLOCK

    val headingSpans = text.getSpans(start, end, HeadingSpan::class.java)
    if (headingSpans.isNotEmpty()) return headingSpans[0].level.coerceIn(1, 6)

    if (text.getSpans(start, end, BlockquoteSpan::class.java).isNotEmpty()) return TYPE_BLOCKQUOTE

    return when (listSpan) {
      is TaskListSpan -> TYPE_TASK_LIST
      is OrderedListSpan -> TYPE_ORDERED_LIST
      is UnorderedListSpan -> TYPE_UNORDERED_LIST
      else -> TYPE_NORMAL
    }
  }

  private fun getDepthForType(
    text: Spannable,
    start: Int,
    type: Int,
    listSpan: BaseListSpan?,
  ): Int =
    when (type) {
      TYPE_BLOCKQUOTE -> {
        text.getSpans(start, start + 1, BlockquoteSpan::class.java).maxOfOrNull { it.depth } ?: 0
      }

      TYPE_ORDERED_LIST, TYPE_UNORDERED_LIST, TYPE_TASK_LIST -> {
        listSpan?.depth ?: 0
      }

      else -> {
        0
      }
    }

  fun generateTableHTML(
    rows: List<List<Triple<CharSequence, Boolean, Layout.Alignment>>>,
    style: StyleConfig,
    scaledDensity: Float = 1f,
    density: Float = 1f,
  ): String {
    if (rows.isEmpty()) return ""

    val tableStyle = style.tableStyle
    val cachedStyles = CachedStyles(style, scaledDensity, density)

    val borderColorCSS = colorToCSS(tableStyle.borderColor)
    val borderWidthPx = tableStyle.borderWidth / density
    val borderRadiusPx = tableStyle.borderRadius / density
    val fontSizePx = tableStyle.fontSize / scaledDensity
    val cellPaddingVerticalPx = tableStyle.cellPaddingVertical / density
    val cellPaddingHorizontalPx = tableStyle.cellPaddingHorizontal / density
    val bodyFontWeight = CachedStyles.fontWeightToCSS(tableStyle.fontWeight)

    return buildString(rows.size * 250) {
      append("<table style=\"border-collapse: separate; border-spacing: 0; ")
      append("border: ${borderWidthPx.toInt()}px solid $borderColorCSS; ")
      append("border-radius: ${borderRadiusPx.toInt()}px; ")
      append("overflow: hidden; font-size: ${fontSizePx.toInt()}px;\">")

      var hasOpenedBody = false
      var bodyRowIndex = 0

      for (row in rows) {
        if (row.isEmpty()) continue

        val isHeaderRow = row.first().second

        if (isHeaderRow) {
          append("<thead>")
        } else if (!hasOpenedBody) {
          append("<tbody>")
          hasOpenedBody = true
        }

        append("<tr>")

        for ((cellText, isHeader, alignment) in row) {
          val backgroundColor =
            when {
              isHeader -> colorToCSS(tableStyle.headerBackgroundColor)
              bodyRowIndex % 2 == 0 -> colorToCSS(tableStyle.rowEvenBackgroundColor)
              else -> colorToCSS(tableStyle.rowOddBackgroundColor)
            }
          val textColor = if (isHeader) colorToCSS(tableStyle.headerTextColor) else colorToCSS(tableStyle.color)
          val textAlignment = alignmentToCSS(alignment)
          val fontWeight = if (isHeader) "bold" else bodyFontWeight

          val htmlTag = if (isHeader) "th" else "td"
          append("<$htmlTag style=\"")
          append("padding: ${cellPaddingVerticalPx.toInt()}px ${cellPaddingHorizontalPx.toInt()}px; ")
          append("text-align: $textAlignment; ")
          append("background-color: $backgroundColor; ")
          append("color: $textColor; ")
          append("border: ${borderWidthPx.toInt()}px solid $borderColorCSS; ")
          append("font-weight: $fontWeight;\">")

          if (cellText.isNotEmpty()) {
            if (cellText is Spannable) {
              append(generateInlineHTML(cellText, 0, cellText.length, cachedStyles, false))
            } else {
              escapeHTMLTo(this, cellText.toString())
            }
          }

          append("</$htmlTag>")
        }

        append("</tr>")

        if (isHeaderRow) {
          append("</thead>")
        } else {
          bodyRowIndex++
        }
      }

      if (hasOpenedBody) append("</tbody>")
      append("</table>")
    }
  }

  private fun alignmentToCSS(alignment: Layout.Alignment): String =
    when (alignment) {
      Layout.Alignment.ALIGN_CENTER -> "center"
      Layout.Alignment.ALIGN_OPPOSITE -> "right"
      else -> "left"
    }

  private fun colorToCSS(color: Int): String {
    if (color == 0) return "inherit"
    val alpha = (color shr 24) and 0xFF
    val red = (color shr 16) and 0xFF
    val green = (color shr 8) and 0xFF
    val blue = color and 0xFF
    return if (alpha < 255) "rgba($red, $green, $blue, ${alpha / 255f})" else String.format("#%02X%02X%02X", red, green, blue)
  }

  /** Fast HTML escape using single-pass character scanning. */
  private fun escapeHTMLTo(
    output: StringBuilder,
    text: String,
  ) {
    val len = text.length

    // Fast path: skip if no escaping needed
    var needsEscape = false
    for (i in 0 until len) {
      val c = text[i]
      if (c == '&' || c == '<' || c == '>' || c == '"' || c == '\'') {
        needsEscape = true
        break
      }
    }
    if (!needsEscape) {
      output.append(text)
      return
    }

    for (i in 0 until len) {
      when (val c = text[i]) {
        '&' -> output.append("&amp;")
        '<' -> output.append("&lt;")
        '>' -> output.append("&gt;")
        '"' -> output.append("&quot;")
        '\'' -> output.append("&#39;")
        else -> output.append(c)
      }
    }
  }

  private fun extractMathLatex(
    text: android.text.Spannable,
    start: Int,
    end: Int,
  ): String? {
    return try {
      val mathInlineSpanClass = Class.forName("com.swmansion.enriched.markdown.spans.MathInlineSpan")
      val spans = text.getSpans(start, end, mathInlineSpanClass)
      if (spans.isEmpty()) return null
      val latexField = mathInlineSpanClass.getDeclaredField("latex").apply { isAccessible = true }
      latexField.get(spans[0]) as? String
    } catch (_: Exception) {
      null
    }
  }
}
