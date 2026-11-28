package com.swmansion.enriched.markdown.input.spans

import android.graphics.Paint
import android.text.Spanned
import android.text.style.LineHeightSpan
import android.text.style.UpdateLayout
import com.swmansion.enriched.markdown.input.formatting.MarkdownSpan

/**
 * Adds [spacingPx] of vertical space above a bullet item (counterpart to iOS
 * `paragraphSpacingBefore`). Tagged [MarkdownSpan] for formatter cleanup.
 *
 * StaticLayout treats a LineHeightSpan as paragraph-scoped: [chooseHeight] runs
 * for every wrapped line of the item regardless of the span's character range,
 * and the FontMetricsInt is reused across those calls, so an unguarded relative
 * adjustment compounds line after line (progressively growing gaps). Guard to
 * the single line that contains the span start so only the item's first visual
 * line is spaced, exactly once.
 *
 * [UpdateLayout] makes EditText rebuild the affected lines when the span is
 * added or removed; a plain LineHeightSpan change leaves stale line heights.
 */
class InputListItemSpacingSpan(
  val spacingPx: Int,
) : LineHeightSpan,
  UpdateLayout,
  MarkdownSpan {
  override fun chooseHeight(
    text: CharSequence?,
    start: Int,
    end: Int,
    spanstartv: Int,
    lineHeight: Int,
    fm: Paint.FontMetricsInt?,
  ) {
    if (fm == null || spacingPx <= 0 || text !is Spanned) return
    val spanStart = text.getSpanStart(this)
    if (spanStart < start || spanStart >= end) return
    fm.ascent -= spacingPx
    fm.top -= spacingPx
  }
}
