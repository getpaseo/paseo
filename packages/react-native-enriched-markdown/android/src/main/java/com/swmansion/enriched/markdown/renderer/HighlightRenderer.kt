package com.swmansion.enriched.markdown.renderer

import android.text.SpannableStringBuilder
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.spans.HighlightSpan
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE

class HighlightRenderer : NodeRenderer {
  override fun render(
    node: MarkdownASTNode,
    builder: SpannableStringBuilder,
    onLinkPress: ((String, String) -> Unit)?,
    onLinkLongPress: ((String) -> Unit)?,
    factory: RendererFactory,
  ) {
    factory.renderWithSpan(builder, { factory.renderChildren(node, builder, onLinkPress, onLinkLongPress) }) { start, end, blockStyle ->
      builder.setSpan(
        HighlightSpan(factory.styleCache, blockStyle),
        start,
        end,
        SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
      )
    }
  }
}
