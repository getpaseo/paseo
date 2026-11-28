package com.swmansion.enriched.markdown.input.styles

import android.graphics.Typeface
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import com.swmansion.enriched.markdown.input.formatting.MarkdownSpan
import com.swmansion.enriched.markdown.input.model.FormattingRange
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle
import com.swmansion.enriched.markdown.input.model.StyleType

private class MarkdownBoldSpan :
  StyleSpan(Typeface.BOLD),
  MarkdownSpan

private class MarkdownBoldColorSpan(
  color: Int,
) : ForegroundColorSpan(color),
  MarkdownSpan

class BoldStyleHandler : StyleHandler {
  override val styleType = StyleType.BOLD
  override val mergingConfig = StyleMergingConfig()

  override fun createSpans(
    range: FormattingRange,
    style: InputFormatterStyle,
  ): List<CharacterStyle> {
    val spans = mutableListOf<CharacterStyle>(MarkdownBoldSpan())
    style.boldColor?.let { spans.add(MarkdownBoldColorSpan(it)) }
    return spans
  }

  override fun spanClasses(): List<Class<out CharacterStyle>> = listOf(MarkdownBoldSpan::class.java, MarkdownBoldColorSpan::class.java)
}
