package com.swmansion.enriched.markdown.input.styles

import com.facebook.react.views.text.TextAttributes
import com.swmansion.enriched.markdown.input.model.BlockRange
import com.swmansion.enriched.markdown.input.model.BlockType
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle
import com.swmansion.enriched.markdown.input.spans.InputHeadingSpan

/**
 * Block handler for ATX headings (H1-H6). A single instance serves all six levels:
 * it reads the H-level from each [BlockRange.level], so it is registered in the
 * [com.swmansion.enriched.markdown.input.formatting.InputFormatter] under every
 * `HEADING_n` key. The level — not [blockType] — drives styling and serialization,
 * so [blockType] is only a nominal interface value and never consulted by the
 * formatter (it dispatches on `range.type`).
 */
class HeadingBlockHandler : BlockHandler {
  override val blockType: BlockType = BlockType.HEADING_1

  override fun createSpans(
    blockRange: BlockRange,
    style: InputFormatterStyle,
    bodyTextAttributes: TextAttributes,
  ): List<Any> =
    listOf(
      InputHeadingSpan(
        blockRange.level,
        style,
        headingLineHeightPx(style, blockRange.level, bodyTextAttributes),
      ),
    )

  /**
   * Heading line height is the heading font size plus the body's extra leading
   * (`lineHeight - fontSize`). Returns null when the body has no line height,
   * so the heading keeps its font's natural height.
   */
  private fun headingLineHeightPx(
    style: InputFormatterStyle,
    level: Int,
    bodyTextAttributes: TextAttributes,
  ): Float? {
    val bodyFontSizeSp = bodyTextAttributes.fontSize
    val bodyLineHeightSp = bodyTextAttributes.lineHeight
    if (bodyLineHeightSp.isNaN() || bodyFontSizeSp <= 0f) return null

    val headingStyle = style.headingStyle(level)
    // Convert the heading's px size back to SP so it goes through the same
    // font scaling as the body line height.
    val headingFontSizeSp =
      headingStyle.fontSizePx?.let { fontSizePx ->
        fontSizePx / bodyTextAttributes.effectiveFontSize * bodyFontSizeSp
      } ?: bodyFontSizeSp

    return TextAttributes()
      .apply {
        allowFontScaling = bodyTextAttributes.allowFontScaling
        fontSize = headingFontSizeSp
        lineHeight = headingFontSizeSp + (bodyLineHeightSp - bodyFontSizeSp)
      }.effectiveLineHeight
  }

  override fun spanClasses(): List<Class<*>> = listOf(InputHeadingSpan::class.java)

  override fun markdownLinePrefix(blockRange: BlockRange): String = "#".repeat(blockRange.level.coerceIn(1, 6)) + " "
}
