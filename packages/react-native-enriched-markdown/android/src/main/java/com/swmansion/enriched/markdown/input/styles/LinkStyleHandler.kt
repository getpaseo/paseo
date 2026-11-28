package com.swmansion.enriched.markdown.input.styles

import android.text.style.BackgroundColorSpan
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.UnderlineSpan
import com.swmansion.enriched.markdown.input.formatting.MarkdownSpan
import com.swmansion.enriched.markdown.input.model.FormattingRange
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle
import com.swmansion.enriched.markdown.input.model.StyleType

private class MarkdownLinkColorSpan(
  color: Int,
) : ForegroundColorSpan(color),
  MarkdownSpan

private class MarkdownLinkUnderlineSpan :
  UnderlineSpan(),
  MarkdownSpan

class LinkStyleHandler : StyleHandler {
  override val styleType = StyleType.LINK
  override val mergingConfig = StyleMergingConfig()

  override fun createSpans(
    range: FormattingRange,
    style: InputFormatterStyle,
  ): List<CharacterStyle> {
    val linkStyle = resolveLinkStyle(range.url, style)
    val spans = mutableListOf<CharacterStyle>(MarkdownLinkColorSpan(linkStyle.color))
    if (linkStyle.underline) {
      spans.add(MarkdownLinkUnderlineSpan())
    }
    if (linkStyle.backgroundColor != 0) {
      spans.add(MarkdownLinkBackgroundColorSpan(linkStyle.backgroundColor))
    }
    return spans
  }

  override fun spanClasses(): List<Class<out CharacterStyle>> =
    listOf(
      MarkdownLinkColorSpan::class.java,
      MarkdownLinkUnderlineSpan::class.java,
      MarkdownLinkBackgroundColorSpan::class.java,
    )

  private fun resolveLinkStyle(
    url: String?,
    style: InputFormatterStyle,
  ): ResolvedLinkStyle {
    val variant =
      url?.let { linkUrl ->
        style.linkVariants.firstOrNull { variant ->
          variant.compiledRegex?.containsMatchIn(linkUrl) == true
        }
      }

    return ResolvedLinkStyle(
      color = variant?.color ?: style.linkColor,
      underline = variant?.underline ?: style.linkUnderline,
      backgroundColor = variant?.backgroundColor ?: style.linkBackgroundColor,
    )
  }

  private data class ResolvedLinkStyle(
    val color: Int,
    val underline: Boolean,
    val backgroundColor: Int,
  )
}

private class MarkdownLinkBackgroundColorSpan(
  color: Int,
) : BackgroundColorSpan(color),
  MarkdownSpan
