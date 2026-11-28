package com.swmansion.enriched.markdown.input.autolink

import android.text.Spannable
import com.swmansion.enriched.markdown.input.detection.TextDetector
import com.swmansion.enriched.markdown.input.detection.WordResult
import com.swmansion.enriched.markdown.input.formatting.FormattingStore
import com.swmansion.enriched.markdown.input.model.FormattingRange
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle
import com.swmansion.enriched.markdown.input.model.StyleType
import com.swmansion.enriched.markdown.utils.common.LinkRegexConfig
import java.util.regex.Pattern

typealias OnLinkDetectedCallback = (text: String, url: String, start: Int, end: Int) -> Unit

class AutoLinkDetector(
  private val formattingStore: FormattingStore,
) : TextDetector {
  private var config: LinkRegexConfig? = null
  private var compiledPattern: Pattern? = null
  var style: InputFormatterStyle? = null
  var onLinkDetected: OnLinkDetectedCallback? = null

  fun setRegexConfig(newConfig: LinkRegexConfig) {
    if (newConfig == config) return
    config = newConfig
    compiledPattern = null

    if (!newConfig.isDefault && !newConfig.isDisabled && newConfig.pattern.isNotEmpty()) {
      var flags = 0
      if (newConfig.caseInsensitive) flags = flags or Pattern.CASE_INSENSITIVE
      if (newConfig.dotAll) flags = flags or Pattern.DOTALL
      compiledPattern =
        try {
          Pattern.compile(newConfig.pattern, flags)
        } catch (_: Exception) {
          null
        }
    }
  }

  override fun processWord(
    spannable: Spannable,
    wordResult: WordResult,
  ) {
    val detectedUrl = detectNewLinkInWord(spannable, wordResult)
    if (detectedUrl != null) {
      onLinkDetected?.invoke(wordResult.word, detectedUrl, wordResult.start, wordResult.end)
    }
  }

  override fun refreshStyling(spannable: Spannable) {
    val currentStyle = style ?: return
    val markers = spannable.getSpans(0, spannable.length, AutoDetectedLinkMarkerSpan::class.java)
    for (marker in markers) {
      val start = spannable.getSpanStart(marker)
      val end = spannable.getSpanEnd(marker)
      applyVisualStyling(spannable, start, end, currentStyle)
    }
  }

  override fun transientFormattingRanges(spannable: Spannable): List<FormattingRange> {
    val markers = spannable.getSpans(0, spannable.length, AutoDetectedLinkMarkerSpan::class.java)
    return markers.map { marker ->
      FormattingRange(
        StyleType.LINK,
        spannable.getSpanStart(marker),
        spannable.getSpanEnd(marker),
        marker.url,
      )
    }
  }

  fun clearAutoLinkInRange(
    spannable: Spannable,
    start: Int,
    end: Int,
  ) {
    removeAutoLinkSpans(spannable, start, end)
  }

  private fun detectNewLinkInWord(
    spannable: Spannable,
    wordResult: WordResult,
  ): String? {
    if (config?.isDisabled == true) return null

    val (word, wordStart, wordEnd) = wordResult

    val hasManualLink = formattingStore.rangeOfType(StyleType.LINK, wordStart) != null
    if (hasManualLink) {
      removeAutoLinkSpans(spannable, wordStart, wordEnd)
      return null
    }

    val matchedUrl = matchWord(word)
    val existingMarker =
      spannable
        .getSpans(wordStart, wordEnd, AutoDetectedLinkMarkerSpan::class.java)
        .firstOrNull { spannable.getSpanStart(it) == wordStart && spannable.getSpanEnd(it) == wordEnd }

    if (matchedUrl != null) {
      if (existingMarker?.url == matchedUrl) return null

      removeAutoLinkSpans(spannable, wordStart, wordEnd)
      spannable.setSpan(
        AutoDetectedLinkMarkerSpan(matchedUrl),
        wordStart,
        wordEnd,
        Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
      )
      val currentStyle = style
      if (currentStyle != null) {
        applyVisualStyling(spannable, wordStart, wordEnd, currentStyle)
      }
      return matchedUrl
    } else {
      if (existingMarker != null) {
        removeAutoLinkSpans(spannable, wordStart, wordEnd)
      }
      return null
    }
  }

  private fun matchWord(word: String): String? {
    if (word.isEmpty()) return null

    val custom = compiledPattern
    if (custom != null) {
      return if (custom.matcher(word).matches()) normalizeUrl(word) else null
    }

    if (DEFAULT_PATTERN.matcher(word).matches()) return normalizeUrl(word)

    return null
  }

  private fun removeAutoLinkSpans(
    spannable: Spannable,
    start: Int,
    end: Int,
  ) {
    for (span in spannable.getSpans(start, end, AutoDetectedLinkMarkerSpan::class.java)) {
      spannable.removeSpan(span)
    }
    for (span in spannable.getSpans(start, end, AutoDetectedLinkColorSpan::class.java)) {
      spannable.removeSpan(span)
    }
    for (span in spannable.getSpans(start, end, AutoDetectedLinkUnderlineSpan::class.java)) {
      spannable.removeSpan(span)
    }
  }

  private fun applyVisualStyling(
    spannable: Spannable,
    start: Int,
    end: Int,
    style: InputFormatterStyle,
  ) {
    spannable.setSpan(
      AutoDetectedLinkColorSpan(style.linkColor),
      start,
      end,
      Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
    )
    if (style.linkUnderline) {
      spannable.setSpan(
        AutoDetectedLinkUnderlineSpan(),
        start,
        end,
        Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
      )
    }
  }

  companion object {
    private val DEFAULT_PATTERN: Pattern =
      Pattern.compile(
        "(?:https?://[-a-zA-Z0-9@:%._+~#=]{1,256}\\.[a-z]{2,6}\\b[-a-zA-Z0-9@:%_+.~#?&//=]*" +
          "|www\\.[-a-zA-Z0-9@:%._+~#=]{1,256}\\.[a-z]{2,6}\\b[-a-zA-Z0-9@:%_+.~#?&//=]*" +
          "|[-a-zA-Z0-9@:%._+~#=]{1,256}\\.[a-z]{2,6}\\b[-a-zA-Z0-9@:%_+.~#?&//=]*)",
        Pattern.CASE_INSENSITIVE,
      )

    private fun normalizeUrl(url: String): String {
      if (url.startsWith("http://") || url.startsWith("https://")) return url
      return "https://$url"
    }
  }
}
