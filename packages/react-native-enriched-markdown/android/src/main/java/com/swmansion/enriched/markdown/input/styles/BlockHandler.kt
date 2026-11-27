package com.swmansion.enriched.markdown.input.styles

import com.facebook.react.views.text.TextAttributes
import com.swmansion.enriched.markdown.input.model.BlockRange
import com.swmansion.enriched.markdown.input.model.BlockType
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle

/**
 * A block handler owns how its [BlockType] styles its paragraph and how it
 * serializes to a markdown line prefix. Mirrors [StyleHandler] for the inline
 * pipeline. Parser recognition is NOT handler-driven: it lives in
 * [com.swmansion.enriched.markdown.input.formatting.InputParser]'s central
 * `nodeTypeToBlockType` map, exactly as `nodeTypeToStyleType` does for inline
 * styles — a new block type adds one entry there plus one handler here.
 *
 * Block spans are paragraph-scoped and applied over the block's whole line range
 * by [com.swmansion.enriched.markdown.input.formatting.InputFormatter]. Unlike
 * inline [StyleHandler.createSpans] (which returns `CharacterStyle`), a block
 * handler returns `List<Any>` so it can mix character spans (a heading's
 * metric/size span) with paragraph spans (a list item's `LeadingMarginSpan` and
 * line-spacing span).
 *
 * These signatures are designed to cover headings AND list items.
 */
interface BlockHandler {
  val blockType: BlockType

  /**
   * Whether Enter continues the block onto the next line (a list item) rather
   * than ending it (a heading). Keeps Enter behavior handler-driven.
   */
  val continuesOnNewline: Boolean
    get() = false

  /**
   * Spans to apply over the block's line range. Returned spans are tagged with
   * [com.swmansion.enriched.markdown.input.formatting.MarkdownSpan] so the
   * formatter can clean up only spans it created. A heading raises the font
   * size; a list item sets a leading margin and a marker. May be empty.
   */
  fun createSpans(
    blockRange: BlockRange,
    style: InputFormatterStyle,
    bodyTextAttributes: TextAttributes,
  ): List<Any>

  /** Span classes this handler produces, for cleanup/identity (mirrors [StyleHandler.spanClasses]). */
  fun spanClasses(): List<Class<*>>

  /**
   * Markdown prefix prepended to each line of the block during serialization,
   * e.g. `"# "` for an H1 or `"- "` for a bullet. Returns `""` when the block
   * needs no prefix. Owning the marker here replaces a central serializer switch.
   */
  fun markdownLinePrefix(blockRange: BlockRange): String
}
