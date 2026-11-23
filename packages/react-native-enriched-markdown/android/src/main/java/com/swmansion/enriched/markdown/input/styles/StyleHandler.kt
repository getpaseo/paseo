package com.swmansion.enriched.markdown.input.styles

import android.text.style.CharacterStyle
import com.swmansion.enriched.markdown.input.model.FormattingRange
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle
import com.swmansion.enriched.markdown.input.model.StyleType

interface StyleHandler {
  val styleType: StyleType
  val mergingConfig: StyleMergingConfig

  fun createSpans(
    range: FormattingRange,
    style: InputFormatterStyle,
  ): List<CharacterStyle>

  fun spanClasses(): List<Class<out CharacterStyle>>
}
