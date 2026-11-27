package com.swmansion.enriched.markdown.renderer

import android.graphics.Paint
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.LineHeightSpan
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.spans.CodeBlockSpan
import com.swmansion.enriched.markdown.spans.MarginBottomSpan
import com.swmansion.enriched.markdown.utils.common.CodeBlockHighlighter
import com.swmansion.enriched.markdown.utils.common.CodeBlockNode
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE
import com.swmansion.enriched.markdown.utils.text.span.applyMarginTop

class CodeBlockRenderer(
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

    val start = builder.length
    val style = config.style.codeBlockStyle
    val context = factory.blockStyleContext

    applyMarginTop(builder, start, style.marginTop)

    // Content starts after the potential 1-character marginTop spacer
    val contentStart = start + (if (style.marginTop > 0) 1 else 0)

    context.setCodeBlockStyle(style)

    try {
      factory.renderChildren(node, builder, onLinkPress, onLinkLongPress)
    } finally {
      context.popBlockStyle()
    }

    if (builder.length == contentStart) return

    val end = builder.length

    CodeBlockHighlighter.highlight(
      builder,
      CodeBlockNode.extractCode(node),
      CodeBlockNode.language(node),
      style,
      contentStart,
    )

    val padding = style.padding.toInt()

    // Apply background, borders, and horizontal padding to content only
    builder.setSpan(
      CodeBlockSpan(
        style,
        factory.context,
        factory.styleCache,
        context.accumulatedIndent,
        CodeBlockNode.extractCode(node),
        CodeBlockNode.language(node) ?: "",
      ),
      contentStart,
      end,
      SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
    )

    // Apply vertical padding via line height manipulation
    builder.setSpan(
      CodeBlockBoundaryPaddingSpan(padding),
      contentStart,
      end,
      SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
    )

    val marginStart = builder.length
    builder.append("\n")
    builder.setSpan(
      MarginBottomSpan(style.marginBottom),
      marginStart,
      builder.length,
      SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
    )
  }

  /**
   * Internal span to handle top/bottom padding by modifying font metrics.
   */
  private class CodeBlockBoundaryPaddingSpan(
    private val padding: Int,
  ) : LineHeightSpan {
    override fun chooseHeight(
      text: CharSequence,
      startLine: Int,
      endLine: Int,
      spanstartv: Int,
      v: Int,
      fm: Paint.FontMetricsInt,
    ) {
      if (text !is Spanned) return

      val spanStart = text.getSpanStart(this)
      val spanEnd = text.getSpanEnd(this)

      // Adjust ascent/top for the first line to create internal top padding
      if (startLine == spanStart) {
        fm.ascent -= padding
        fm.top -= padding
      }

      // Adjust descent/bottom for the last line (handling trailing newlines)
      val isLastLine = endLine == spanEnd || (spanEnd <= endLine && text[spanEnd - 1] == '\n')
      if (isLastLine) {
        fm.descent += padding
        fm.bottom += padding
      }
    }
  }
}
