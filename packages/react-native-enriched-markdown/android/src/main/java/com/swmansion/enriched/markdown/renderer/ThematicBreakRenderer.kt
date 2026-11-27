package com.swmansion.enriched.markdown.renderer

import android.text.SpannableStringBuilder
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.spans.ThematicBreakSpan
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE

class ThematicBreakRenderer(
  private val config: RendererConfig,
) : NodeRenderer {
  override fun render(
    node: MarkdownASTNode,
    builder: SpannableStringBuilder,
    onLinkPress: ((String, String) -> Unit)?,
    onLinkLongPress: ((String) -> Unit)?,
    factory: RendererFactory,
  ) {
    builder.ensureNewline()

    val start = builder.length

    builder.append(" \n")
    val end = builder.length

    val style = config.style.thematicBreakStyle

    builder.setSpan(
      ThematicBreakSpan(
        style.color,
        style.height,
        style.marginTop,
        style.marginBottom,
      ),
      start,
      end,
      SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
    )
  }

  private fun SpannableStringBuilder.ensureNewline() {
    if (isNotEmpty() && this[length - 1] != '\n') {
      append('\n')
    }
  }
}
