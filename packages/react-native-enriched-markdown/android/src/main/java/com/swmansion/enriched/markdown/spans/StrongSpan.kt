package com.swmansion.enriched.markdown.spans

import android.graphics.Typeface
import android.text.TextPaint
import android.text.style.MetricAffectingSpan
import com.swmansion.enriched.markdown.renderer.BlockStyle
import com.swmansion.enriched.markdown.renderer.SpanStyleCache
import com.swmansion.enriched.markdown.utils.text.extensions.applyColorPreserving

class StrongSpan(
  private val styleCache: SpanStyleCache,
  private val blockStyle: BlockStyle,
) : MetricAffectingSpan() {
  private val strongColor = styleCache.getStrongColorFor(blockStyle.color)

  override fun updateDrawState(tp: TextPaint) {
    applyStrongStyle(tp)
    tp.applyColorPreserving(strongColor, *styleCache.colorsToPreserve)
  }

  override fun updateMeasureState(tp: TextPaint) {
    applyStrongStyle(tp)
  }

  private fun applyStrongStyle(tp: TextPaint) {
    // Weight composes with the current run; its size belongs to the block or code span.
    val currentTypeface = tp.typeface ?: Typeface.DEFAULT
    val isItalic = (currentTypeface.style) and Typeface.ITALIC != 0
    val style = if (isItalic) Typeface.BOLD_ITALIC else Typeface.BOLD
    tp.typeface =
      if (styleCache.strongFontFamily.isNotEmpty()) {
        val resolvedStyle = if (styleCache.strongFontWeight == "normal") Typeface.NORMAL else style
        styleCache.getTypeface(styleCache.strongFontFamily, resolvedStyle)
      } else {
        Typeface.create(currentTypeface, style)
      }
  }
}
