package com.swmansion.enriched.markdown.input.autolink

import android.text.TextPaint
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.UnderlineSpan

/**
 * Visual spans for auto-detected links. These intentionally do NOT implement
 * MarkdownSpan so they survive the diff-based removal in InputFormatter.applyFormatting.
 */
class AutoDetectedLinkColorSpan(
  color: Int,
) : ForegroundColorSpan(color)

class AutoDetectedLinkUnderlineSpan : UnderlineSpan()

/**
 * Zero-width marker span that carries the matched URL and marks a range as
 * auto-detected. Used to enumerate existing auto-link ranges without confusing
 * them with manual MarkdownSpan link spans.
 */
class AutoDetectedLinkMarkerSpan(
  val url: String,
) : CharacterStyle() {
  override fun updateDrawState(tp: TextPaint) {
    // no-op — styling is handled by the color/underline spans
  }
}
