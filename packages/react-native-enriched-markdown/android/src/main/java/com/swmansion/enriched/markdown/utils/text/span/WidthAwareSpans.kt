package com.swmansion.enriched.markdown.utils.text.span

import android.text.Spanned
import com.swmansion.enriched.markdown.spans.ImageSpan
import com.swmansion.enriched.markdown.spans.LinkPillSpan

/**
 * Primes every span whose size depends on the layout width (pills, images). Call it
 * before building any layout over [text]. [includeImages] is off for a visible text
 * view, whose image spans size themselves from the view they are registered with.
 *
 * Returns true when a pill's width limit changed, i.e. an existing layout is stale.
 */
fun prepareWidthAwareSpans(
  text: CharSequence?,
  widthPx: Int,
  includeImages: Boolean = true,
): Boolean {
  val spanned = text as? Spanned ?: return false
  // widthPx == 1 is the coerceAtLeast(1) fallback for a not-yet-measured view. Priming
  // with it would squeeze pills on screen to a sliver until the next real measure.
  if (widthPx <= 1) return false
  val pillsChanged = LinkPillSpan.prepareForMeasurement(spanned, widthPx)
  if (includeImages) {
    spanned
      .getSpans(0, spanned.length, ImageSpan::class.java)
      .forEach { it.prepareForMeasurement(spanned, widthPx) }
  }
  return pillsChanged
}
