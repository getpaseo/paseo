package com.swmansion.enriched.markdown.input.styles

import android.graphics.Typeface
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import com.swmansion.enriched.markdown.input.formatting.MarkdownSpan
import com.swmansion.enriched.markdown.input.model.FormattingRange
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle
import com.swmansion.enriched.markdown.input.model.StyleType

private class MarkdownItalicSpan :
  StyleSpan(Typeface.ITALIC),
  MarkdownSpan

private class MarkdownItalicColorSpan(
  color: Int,
) : ForegroundColorSpan(color),
  MarkdownSpan

class ItalicStyleHandler : StyleHandler {
  override val styleType = StyleType.ITALIC
  override val mergingConfig = StyleMergingConfig()

  override fun createSpans(
    range: FormattingRange,
    style: InputFormatterStyle,
  ): List<CharacterStyle> {
    val spans = mutableListOf<CharacterStyle>(MarkdownItalicSpan())
    style.italicColor?.let { spans.add(MarkdownItalicColorSpan(it)) }
    return spans
  }

  override fun spanClasses(): List<Class<out CharacterStyle>> = listOf(MarkdownItalicSpan::class.java, MarkdownItalicColorSpan::class.java)
}
