package com.swmansion.enriched.markdown.input.styles

import com.facebook.react.views.text.TextAttributes
import com.swmansion.enriched.markdown.input.model.BlockRange
import com.swmansion.enriched.markdown.input.model.BlockType
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle
import com.swmansion.enriched.markdown.input.spans.InputListItemSpacingSpan
import com.swmansion.enriched.markdown.input.spans.InputOrderedListMarkerSpan

/**
 * Block handler for ordered list items. One instance serves every nesting depth —
 * the 0-based depth rides in [BlockRange.level] and the displayed number in
 * [BlockRange.ordinal], both maintained by the block store.
 */
class OrderedListBlockHandler(
  private val density: Float,
) : BlockHandler {
  override val blockType: BlockType = BlockType.ORDERED_LIST_ITEM

  override val continuesOnNewline: Boolean = true

  override fun createSpans(
    blockRange: BlockRange,
    style: InputFormatterStyle,
    bodyTextAttributes: TextAttributes,
  ): List<Any> {
    val spans = mutableListOf<Any>(InputOrderedListMarkerSpan(blockRange.level, blockRange.ordinal, density))
    val spacingPx = (style.listItemSpacing * density).toInt()
    if (spacingPx > 0) {
      spans.add(InputListItemSpacingSpan(spacingPx))
    }
    return spans
  }

  override fun spanClasses(): List<Class<*>> = listOf(InputOrderedListMarkerSpan::class.java, InputListItemSpacingSpan::class.java)

  /** `"1. "` numbering from the range's ordinal, indented three spaces per nesting depth. */
  override fun markdownLinePrefix(blockRange: BlockRange): String =
    "   ".repeat(blockRange.level.coerceAtLeast(0)) + "${blockRange.ordinal}. "
}
