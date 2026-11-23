package com.swmansion.enriched.markdown.utils.text.extensions

import android.content.Context
import android.graphics.Typeface
import android.text.TextPaint
import com.facebook.react.common.ReactConstants
import com.facebook.react.views.text.ReactTypefaceUtils.applyStyles
import com.facebook.react.views.text.ReactTypefaceUtils.parseFontWeight
import com.swmansion.enriched.markdown.renderer.BlockStyle
import com.swmansion.enriched.markdown.styles.CodeBlockStyle

fun TextPaint.applyColorPreserving(
  color: Int,
  vararg preserveColors: Int,
) {
  if (this.color !in preserveColors) {
    this.color = color
  }
}

private val typefaceCache = mutableMapOf<String, Typeface>()
private val fontWeightCache = mutableMapOf<String?, Int>()

fun TextPaint.applyBlockStyleFont(
  blockStyle: BlockStyle,
  context: Context,
) {
  val cacheKey = "${blockStyle.fontFamily}|${blockStyle.fontWeight}"

  val cachedTypeface = typefaceCache[cacheKey]
  if (cachedTypeface != null) {
    this.typeface = cachedTypeface
    return
  }

  val fontWeight =
    fontWeightCache.getOrPut(blockStyle.fontWeight) {
      parseFontWeight(blockStyle.fontWeight)
    }

  // Pass null as base typeface - this matches React Native Text behavior
  // applyStyles will use ReactFontManager to load custom fonts from assets
  val newTypeface =
    applyStyles(
      null, // Let applyStyles handle font loading from assets
      ReactConstants.UNSET,
      fontWeight,
      blockStyle.fontFamily.takeIf { it.isNotEmpty() },
      context.assets,
    )

  typefaceCache[cacheKey] = newTypeface
  this.typeface = newTypeface
}

/**
 * Code block text sizing and font, shared by both flavors (CodeBlockSpan for
 * commonmark, CodeBlockContainerView for github) so the code always renders
 * and measures with the same paint. Color is applied by the callers: the span
 * needs color preserving, the view colors via the text view.
 */
fun TextPaint.applyCodeBlockTextStyle(
  style: CodeBlockStyle,
  context: Context,
) {
  textSize = style.fontSize
  applyBlockStyleFont(
    BlockStyle(
      fontSize = style.fontSize,
      fontFamily = style.fontFamily,
      fontWeight = style.fontWeight,
      color = style.color,
    ),
    context,
  )
}
