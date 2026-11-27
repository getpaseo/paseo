package com.swmansion.enriched.markdown.spans

import android.text.TextPaint
import android.text.style.MetricAffectingSpan
import com.swmansion.enriched.markdown.renderer.BlockStyle
import com.swmansion.enriched.markdown.renderer.SpanStyleCache

class SpoilerSpan(
  val styleCache: SpanStyleCache,
  val blockStyle: BlockStyle,
) : MetricAffectingSpan() {
  var revealed = false
    private set
  var revealing = false
    private set

  fun markRevealing() {
    revealing = true
  }

  fun markRevealed() {
    revealed = true
    revealing = false
  }

  override fun updateDrawState(tp: TextPaint) {
    tp.textSize = blockStyle.fontSize
  }

  override fun updateMeasureState(tp: TextPaint) {
    tp.textSize = blockStyle.fontSize
  }
}
