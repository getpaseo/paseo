package com.swmansion.enriched.markdown.renderer

import com.swmansion.enriched.markdown.spans.BaselineShiftSpan

class SuperscriptRenderer : BaselineShiftRenderer() {
  override fun fontScale(factory: RendererFactory): Float = factory.styleCache.superscriptFontScale

  override fun baselineOffsetScale(factory: RendererFactory): Float = factory.styleCache.superscriptBaselineOffsetScale

  override fun spanType(): BaselineShiftSpan.SpanType = BaselineShiftSpan.SpanType.SUPERSCRIPT
}
