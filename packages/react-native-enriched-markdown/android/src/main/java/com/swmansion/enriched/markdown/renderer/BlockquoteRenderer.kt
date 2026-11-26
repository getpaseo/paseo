package com.swmansion.enriched.markdown.renderer

import android.graphics.Paint
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.LineHeightSpan
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.spans.BlockquoteSpan
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE_PRIORITY
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_LINE_HEIGHT_PRIORITY
import com.swmansion.enriched.markdown.utils.text.span.applyLineHeightSkippingImages
import com.swmansion.enriched.markdown.utils.text.span.applyMarginBottom
import com.swmansion.enriched.markdown.utils.text.span.applyMarginTop

class BlockquoteRenderer(
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
    val style = config.style.blockquoteStyle
    val context = factory.blockStyleContext
    val depth = context.blockquoteDepth

    // Track depth to handle nested indentation levels
    context.blockquoteDepth = depth + 1
    context.setBlockquoteStyle(style)

    try {
      factory.renderChildren(node, builder, onLinkPress, onLinkLongPress)
    } finally {
      context.popBlockStyle()
      context.blockquoteDepth = depth
    }

    if (builder.length == start) return
    var end = builder.length
    val padding = style.padding.toInt()

    var contentStart = start
    if (padding > 0) {
      builder.insert(start, "\n")
      factory.shiftDeferredSpans(start, 1)
      builder.setSpan(
        BlockquotePaddingSpacerSpan(padding),
        start,
        start + 1,
        SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
      )
      contentStart = start + 1
      end += 1
    }

    // Find immediately nested quotes to exclude them from this level's line-height/margins
    val nestedRanges =
      builder
        .getSpans(contentStart, end, BlockquoteSpan::class.java)
        .filter { it.depth == depth + 1 }
        .map { builder.getSpanStart(it) to builder.getSpanEnd(it) }
        .sortedBy { it.first }

    // The accent bar / background span covers the full box, incl. the top spacer.
    // Top priority draws it first, so inline pill/chip backgrounds paint on top of its fill.
    builder.setSpan(
      BlockquoteSpan(style, depth, factory.context, factory.styleCache),
      start,
      end,
      SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE_PRIORITY,
    )

    applyLineHeightExcludingNested(builder, nestedRanges, contentStart, end, style.lineHeight)

    if (padding > 0) {
      builder.setSpan(
        BlockquoteBoundaryPaddingSpan(padding),
        contentStart,
        end,
        SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
      )
    }

    // Margins are only applied by the outermost (root) quote
    if (depth == 0) {
      applyMarginTop(builder, start, style.marginTop)
      applyMarginBottom(builder, style.marginBottom)
    }
  }

  /**
   * A blockquote's top padding, rendered as a standalone spacer line of exactly
   * [padding] px.
   *
   * Top padding cannot be added by growing the first content line's ascent:
   * StaticLayout reuses one FontMetricsInt across a paragraph's soft-wrapped lines,
   * so the inflated first-line metrics leak into the wrapped continuation line, where
   * the line-height clamp then skews them into overlapping baselines. A spacer sits in
   * its own paragraph, and setting absolute metrics keeps it fixed regardless of that
   * reuse.
   */
  private class BlockquotePaddingSpacerSpan(
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
      fm.top = 0
      fm.ascent = 0
      fm.descent = padding
      fm.bottom = padding
    }
  }

  /**
   * A blockquote's bottom padding, grown onto the last content line's descent (safe
   * because no later line inherits its metrics; top padding uses
   * [BlockquotePaddingSpacerSpan]).
   *
   * The span range can include trailing '\n'(s) that form no visible line, so the last
   * drawn line ends before getSpanEnd; the comparison uses the visible content end.
   */
  private class BlockquoteBoundaryPaddingSpan(
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

      var contentEnd = text.getSpanEnd(this)
      while (contentEnd > 0 && text[contentEnd - 1] == '\n') {
        contentEnd--
      }
      if (endLine >= contentEnd) {
        fm.descent += padding
        fm.bottom += padding
      }
    }
  }

  private fun applyLineHeightExcludingNested(
    builder: SpannableStringBuilder,
    nestedRanges: List<Pair<Int, Int>>,
    start: Int,
    end: Int,
    lineHeight: Float,
  ) {
    var currentPos = start
    for ((nestedStart, nestedEnd) in nestedRanges) {
      if (currentPos < nestedStart) {
        applyLineHeightSkippingImages(builder, currentPos, nestedStart, lineHeight, SPAN_FLAGS_LINE_HEIGHT_PRIORITY)
      }
      currentPos = nestedEnd
    }
    if (currentPos < end) {
      applyLineHeightSkippingImages(builder, currentPos, end, lineHeight, SPAN_FLAGS_LINE_HEIGHT_PRIORITY)
    }
  }
}
