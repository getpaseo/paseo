package com.swmansion.enriched.markdown.input.styles

import android.text.style.BackgroundColorSpan
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import com.swmansion.enriched.markdown.input.formatting.MarkdownSpan
import com.swmansion.enriched.markdown.input.model.FormattingRange
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle
import com.swmansion.enriched.markdown.input.model.StyleType

private class MarkdownSpoilerColorSpan(
  color: Int,
) : ForegroundColorSpan(color),
  MarkdownSpan

private class MarkdownSpoilerBackgroundSpan(
  color: Int,
) : BackgroundColorSpan(color),
  MarkdownSpan

class SpoilerStyleHandler : StyleHandler {
  override val styleType = StyleType.SPOILER
  override val mergingConfig = StyleMergingConfig()

  override fun createSpans(
    range: FormattingRange,
    style: InputFormatterStyle,
  ): List<CharacterStyle> =
    listOf(
      MarkdownSpoilerColorSpan(style.spoilerColor),
      MarkdownSpoilerBackgroundSpan(style.spoilerBackgroundColor),
    )

  override fun spanClasses(): List<Class<out CharacterStyle>> =
    listOf(MarkdownSpoilerColorSpan::class.java, MarkdownSpoilerBackgroundSpan::class.java)
}
