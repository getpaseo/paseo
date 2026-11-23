package com.swmansion.enriched.markdown.input.styles

import android.text.style.CharacterStyle
import android.text.style.StrikethroughSpan
import com.swmansion.enriched.markdown.input.formatting.MarkdownSpan
import com.swmansion.enriched.markdown.input.model.FormattingRange
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle
import com.swmansion.enriched.markdown.input.model.StyleType

private class MarkdownStrikethroughSpan :
  StrikethroughSpan(),
  MarkdownSpan

class StrikethroughStyleHandler : StyleHandler {
  override val styleType = StyleType.STRIKETHROUGH
  override val mergingConfig = StyleMergingConfig()

  override fun createSpans(
    range: FormattingRange,
    style: InputFormatterStyle,
  ): List<CharacterStyle> = listOf(MarkdownStrikethroughSpan())

  override fun spanClasses(): List<Class<out CharacterStyle>> = listOf(MarkdownStrikethroughSpan::class.java)
}
