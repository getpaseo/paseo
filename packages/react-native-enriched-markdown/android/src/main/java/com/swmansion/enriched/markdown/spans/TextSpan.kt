package com.swmansion.enriched.markdown.spans

import android.content.Context
import android.text.TextPaint
import android.text.style.MetricAffectingSpan
import com.swmansion.enriched.markdown.renderer.BlockStyle
import com.swmansion.enriched.markdown.utils.text.extensions.applyBlockStyleFont

class TextSpan(
  private val blockStyle: BlockStyle,
  private val context: Context,
) : MetricAffectingSpan() {
  override fun updateDrawState(tp: TextPaint) {
    applyBlockStyle(tp)
  }

  override fun updateMeasureState(tp: TextPaint) {
    applyBlockStyle(tp)
  }

  private fun applyBlockStyle(tp: TextPaint) {
    tp.textSize = blockStyle.fontSize
    tp.color = blockStyle.color
    tp.applyBlockStyleFont(blockStyle, context)
  }
}
