package com.swmansion.enriched.markdown.renderer

import android.text.SpannableStringBuilder
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.spans.BaselineShiftSpan

abstract class BaselineShiftRenderer : NodeRenderer {
  abstract fun fontScale(factory: RendererFactory): Float

  abstract fun baselineOffsetScale(factory: RendererFactory): Float

  abstract fun spanType(): BaselineShiftSpan.SpanType

  override fun render(
    node: MarkdownASTNode,
    builder: SpannableStringBuilder,
    onLinkPress: ((String, String) -> Unit)?,
    onLinkLongPress: ((String) -> Unit)?,
    factory: RendererFactory,
  ) {
    val start = builder.length
    factory.renderChildren(node, builder, onLinkPress, onLinkLongPress)
    val end = builder.length

    if (end > start) {
      // Block renderers (ListItemRenderer, BlockquoteRenderer, …) add their
      // MetricAffectingSpan AFTER rendering children because they need the full range.
      // Android applies spans in insertion order, so block spans that set tp.textSize
      // absolutely always run last and override fontScale. Deferring this span ensures
      // it is inserted after all block spans and wins.
      //
      // TODO: consider pre-registering each block span with an empty range before
      // renderChildren(), then update the range in-place with a second setSpan() call.
      // SpannableStringBuilder updates the range without moving the span in the array,
      // so block spans stay first and inline spans naturally follow. Once done, remove
      // the deferredSpans mechanism.
      factory.registerDeferredSpan(
        BaselineShiftSpan(fontScale(factory), baselineOffsetScale(factory), spanType()),
        start,
        end,
      )
    }
  }
}
