package com.swmansion.enriched.markdown.renderer

import android.text.SpannableStringBuilder
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.styles.BlockquoteStyle
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_LINE_HEIGHT_PRIORITY
import com.swmansion.enriched.markdown.utils.text.span.applyLineHeightSkippingImages

/**
 * Renders a GFM blockquote's own prose content - the nodes left after nested
 * quotes, code blocks and other block segments have been split out - into a
 * standalone buffer styled as blockquote text.
 *
 * It decorates a generic [Renderer.renderContent] pass rather than owning the
 * render envelope itself: [push] enters the blockquote block style so text picks
 * up the quote's font/color while still emitting block margins between children,
 * matching the commonmark BlockquoteRenderer; [postProcess] applies the quote's
 * line height once the builder is complete. It draws no border/background/padding
 * - the BlockquoteContainerView draws the box.
 */
class BlockquoteTextRenderer(
  private val style: BlockquoteStyle,
) {
  fun render(
    renderer: Renderer,
    nodes: List<MarkdownASTNode>,
    onLinkPress: ((String, String) -> Unit)?,
    onLinkLongPress: ((String) -> Unit)?,
  ): SpannableStringBuilder = renderer.renderContent(nodes, onLinkPress, onLinkLongPress, block = this)

  fun push(context: BlockStyleContext) {
    context.blockquoteDepth += 1
    context.setBlockquoteStyle(style)
  }

  fun pop(context: BlockStyleContext) {
    context.popBlockStyle()
    context.blockquoteDepth -= 1
  }

  fun postProcess(builder: SpannableStringBuilder) {
    if (builder.isNotEmpty()) {
      // Priority flag so this block-wide line height iterates before the per-block
      // MarginBottomSpans, which then add their gap on top instead of being
      // normalized away (see SPAN_FLAGS_LINE_HEIGHT_PRIORITY).
      applyLineHeightSkippingImages(
        builder,
        0,
        builder.length,
        style.lineHeight,
        SPAN_FLAGS_LINE_HEIGHT_PRIORITY,
      )
    }
  }
}
