package com.swmansion.enriched.markdown.input.styles

import android.text.style.CharacterStyle
import android.text.style.UnderlineSpan
import com.swmansion.enriched.markdown.input.formatting.MarkdownSpan
import com.swmansion.enriched.markdown.input.model.FormattingRange
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle
import com.swmansion.enriched.markdown.input.model.StyleType

private class MarkdownUnderlineSpan :
  UnderlineSpan(),
  MarkdownSpan

class UnderlineStyleHandler : StyleHandler {
  override val styleType = StyleType.UNDERLINE
  override val mergingConfig = StyleMergingConfig()

  override fun createSpans(
    range: FormattingRange,
    style: InputFormatterStyle,
  ): List<CharacterStyle> = listOf(MarkdownUnderlineSpan())

  override fun spanClasses(): List<Class<out CharacterStyle>> = listOf(MarkdownUnderlineSpan::class.java)
}
