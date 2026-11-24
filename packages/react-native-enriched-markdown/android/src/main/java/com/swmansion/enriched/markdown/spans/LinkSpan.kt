package com.swmansion.enriched.markdown.spans

import android.content.Context
import android.graphics.Color
import android.text.TextPaint
import android.text.style.ClickableSpan
import android.view.View
import com.swmansion.enriched.markdown.EnrichedMarkdownText
import com.swmansion.enriched.markdown.renderer.BlockStyle
import com.swmansion.enriched.markdown.renderer.SpanStyleCache
import com.swmansion.enriched.markdown.utils.text.extensions.applyBlockStyleFont

class LinkSpan(
  val url: String,
  private val onLinkPress: ((String, String) -> Unit)?,
  private val onLinkLongPress: ((String) -> Unit)?,
  private val styleCache: SpanStyleCache,
  private val blockStyle: BlockStyle,
  private val context: Context,
  val recognizedLink: Boolean = false,
  // Syntax context for recognized inline-code links is independent of typography.
  private val recognizedInlineCodeLink: Boolean = false,
) : ClickableSpan() {
  @Volatile
  private var longPressTriggered = false

  override fun onClick(widget: View) {
    if (longPressTriggered) {
      longPressTriggered = false
      return
    }

    val sourceType = if (recognizedInlineCodeLink) "inline-code" else if (recognizedLink) "text" else "markdown"
    onLinkPress?.invoke(url, sourceType) ?: (widget as? EnrichedMarkdownText)?.emitOnLinkPress(url, sourceType)
  }

  fun onLongClick(widget: View): Boolean {
    longPressTriggered = true

    (widget as? EnrichedMarkdownText)?.emitOnLinkLongPress(url)

    onLinkLongPress?.invoke(url)

    return true
  }

  override fun updateDrawState(textPaint: TextPaint) {
    super.updateDrawState(textPaint)

    val variant = styleCache.resolvedVariantForUrl(url)

    val fontFamily = variant?.fontFamily?.takeIf { it.isNotEmpty() } ?: styleCache.linkFontFamily
    if (fontFamily.isNotEmpty()) {
      textPaint.applyBlockStyleFont(blockStyle.copy(fontFamily = fontFamily), context)
    }

    textPaint.color = variant?.color ?: styleCache.linkColor
    textPaint.isUnderlineText = variant?.underline ?: styleCache.linkUnderline

    val backgroundColor = variant?.backgroundColor ?: styleCache.linkBackgroundColor
    if (Color.alpha(backgroundColor) > 0) {
      textPaint.bgColor = backgroundColor
    }
  }
}
