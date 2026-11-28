package com.swmansion.enriched.markdown.renderer

import android.text.SpannableStringBuilder
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.utils.text.span.applyLineHeightSkippingImages

// Renders a run of consecutive blank lines emitted when preserveBlankLines is
// enabled. Each blank line in the source is drawn as one empty line, using the
// paragraph line height so its vertical rhythm matches the surrounding
// paragraphs. Any extra block spacing comes from the paragraph style and is left
// to the caller to configure.
class BlankLineRenderer(
  private val config: RendererConfig,
) : NodeRenderer {
  override fun render(
    node: MarkdownASTNode,
    builder: SpannableStringBuilder,
    onLinkPress: ((String, String) -> Unit)?,
    onLinkLongPress: ((String) -> Unit)?,
    factory: RendererFactory,
  ) {
    val count = node.getAttribute("count")?.toIntOrNull() ?: 0
    if (count <= 0) {
      return
    }

    builder.ensureNewline()
    val start = builder.length
    builder.append("\n".repeat(count))
    applyLineHeightSkippingImages(builder, start, builder.length, config.style.paragraphStyle.lineHeight)
  }

  private fun SpannableStringBuilder.ensureNewline() {
    if (isNotEmpty() && this[length - 1] != '\n') {
      append('\n')
    }
  }
}
