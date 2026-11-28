package com.swmansion.enriched.markdown.renderer

import com.swmansion.enriched.markdown.spans.BaselineShiftSpan

class SubscriptRenderer : BaselineShiftRenderer() {
  override fun fontScale(factory: RendererFactory): Float = factory.styleCache.subscriptFontScale

  override fun baselineOffsetScale(factory: RendererFactory): Float = -factory.styleCache.subscriptBaselineOffsetScale

  override fun spanType(): BaselineShiftSpan.SpanType = BaselineShiftSpan.SpanType.SUBSCRIPT
}
