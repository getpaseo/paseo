package com.swmansion.enriched.markdown.renderer

import android.text.SpannableStringBuilder
import android.text.style.AlignmentSpan
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.spans.HeadingSpan
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE_PRIORITY
import com.swmansion.enriched.markdown.utils.text.span.applyLinkPillLineHeight
import com.swmansion.enriched.markdown.utils.text.span.applyMarginBottom
import com.swmansion.enriched.markdown.utils.text.span.applyMarginTop
import com.swmansion.enriched.markdown.utils.text.span.createLineHeightSpan

class HeadingRenderer(
  private val config: RendererConfig,
) : NodeRenderer {
  override fun render(
    node: MarkdownASTNode,
    builder: SpannableStringBuilder,
    onLinkPress: ((String, String) -> Unit)?,
    onLinkLongPress: ((String) -> Unit)?,
    factory: RendererFactory,
  ) {
    if (builder.isNotEmpty() && builder.last() != '\n') {
      builder.append("\n")
    }

    val level = node.getAttribute("level")?.toIntOrNull() ?: 1
    val start = builder.length

    val headingStyle = config.style.headingStyles[level]!!
    val blockStyleContext = factory.blockStyleContext
    blockStyleContext.setHeadingStyle(headingStyle, level)

    try {
      factory.renderChildren(node, builder, onLinkPress, onLinkLongPress)
    } finally {
      blockStyleContext.popBlockStyle()
    }

    val end = builder.length
    val contentLength = end - start

    if (contentLength > 0) {
      // Set after the children, so top priority makes it apply first and the
      // inline spans inside the heading (code, links, strong, emphasis) win.
      builder.setSpan(
        HeadingSpan(
          level,
          config.style,
        ),
        start,
        end,
        SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE_PRIORITY,
      )

      builder.setSpan(
        createLineHeightSpan(headingStyle.lineHeight),
        start,
        end,
        SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
      )
      applyLinkPillLineHeight(builder, start, end)

      // Only apply AlignmentSpan for non-default alignments (Center/Right).
      // Justify is handled at the TextView level (API 26+).
      if (headingStyle.textAlign.needsAlignmentSpan) {
        builder.setSpan(
          AlignmentSpan.Standard(headingStyle.textAlign.layoutAlignment),
          start,
          end,
          SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
        )
      }

      applyMarginTop(builder, start, headingStyle.marginTop)
      applyMarginBottom(builder, headingStyle.marginBottom)
    }
  }
}
