package com.swmansion.enriched.markdown.utils.text.span

import android.text.SpannableStringBuilder
import com.swmansion.enriched.markdown.spans.CodeBlockSpan
import com.swmansion.enriched.markdown.spans.ImageSpan
import com.swmansion.enriched.markdown.spans.LineHeightSpan
import com.swmansion.enriched.markdown.spans.LinkPillSpan
import com.swmansion.enriched.markdown.spans.MarginBottomSpan
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE
import android.text.style.LineHeightSpan as AndroidLineHeightSpan

fun createLineHeightSpan(lineHeight: Float): AndroidLineHeightSpan = LineHeightSpan(lineHeight)

/** The line height floor that link pills ask of their paragraph. */
private class LinkPillLineHeightSpan(
  height: Float,
) : AndroidLineHeightSpan by LineHeightSpan(height)

/**
 * Raises the line height of every paragraph in [start]..[end] to the largest
 * `pill.lineHeight` among its link pills. A line grows to fit a pill on its own, but only
 * that line and only to the pill's box, so pills on consecutive lines touch. A style that
 * sets `pill.lineHeight` gets a floor for the whole paragraph instead, which keeps its
 * lines even and the pills apart.
 *
 * Nested blocks set line height over ranges that overlap, so a paragraph that already
 * has its floor is left alone. [spanFlags] are those of the block's own line height span:
 * line height spans apply in order, and the floor has to come before the spans that add a
 * margin to a line, or it would swallow that margin.
 */
fun applyLinkPillLineHeight(
  builder: SpannableStringBuilder,
  start: Int,
  end: Int,
  spanFlags: Int = SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
) {
  val heights = HashMap<Int, Float>()
  for (pill in builder.getSpans(start, end, LinkPillSpan::class.java)) {
    val pillStart = builder.getSpanStart(pill)
    // getSpans also returns a pill that only touches the range.
    if (pill.lineHeight <= 0 || pillStart < start || pillStart >= end) continue
    val paragraphStart = builder.lastIndexOf('\n', pillStart - 1).let { if (it < start) start else it + 1 }
    heights[paragraphStart] = maxOf(heights[paragraphStart] ?: 0f, pill.lineHeight)
  }
  for ((paragraphStart, height) in heights) {
    val paragraphEnd = builder.indexOf('\n', paragraphStart).let { if (it < 0 || it >= end) end else it + 1 }
    // getSpans also returns the floor of a neighbouring paragraph, which only touches this one.
    val hasFloor =
      builder
        .getSpans(paragraphStart, paragraphEnd, LinkPillLineHeightSpan::class.java)
        .any { builder.getSpanStart(it) <= paragraphStart && builder.getSpanEnd(it) > paragraphStart }
    if (hasFloor) continue
    builder.setSpan(LinkPillLineHeightSpan(height), paragraphStart, paragraphEnd, spanFlags)
  }
}

/**
 * Applies [LineHeightSpan] to [start]..[end] but skips ranges occupied by
 * block [ImageSpan]s (and their trailing '\n') and by [CodeBlockSpan]s —
 * both of these apply their own font-metric adjustments that a fixed
 * line height would override.
 */
fun applyLineHeightSkippingImages(
  builder: SpannableStringBuilder,
  start: Int,
  end: Int,
  lineHeight: Float,
  spanFlags: Int = SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
) {
  val blockImageRanges =
    builder
      .getSpans(start, end, ImageSpan::class.java)
      .filter { !it.isInline }
      .map { builder.getSpanStart(it) to builder.getSpanEnd(it) }

  val codeBlockRanges =
    builder
      .getSpans(start, end, CodeBlockSpan::class.java)
      .map { builder.getSpanStart(it) to builder.getSpanEnd(it) }

  val excludedRanges = (blockImageRanges + codeBlockRanges).sortedBy { it.first }

  var pos = start
  for ((exStart, exEnd) in excludedRanges) {
    if (pos < exStart) {
      builder.setSpan(
        createLineHeightSpan(lineHeight),
        pos,
        exStart,
        spanFlags,
      )
    }
    val skipEnd = if (exEnd < end && builder[exEnd] == '\n') exEnd + 1 else exEnd
    pos = maxOf(pos, skipEnd)
  }
  if (pos < end) {
    builder.setSpan(
      createLineHeightSpan(lineHeight),
      pos,
      end,
      spanFlags,
    )
  }
  applyLinkPillLineHeight(builder, start, end, spanFlags)
}

fun applyMarginTop(
  builder: SpannableStringBuilder,
  insertionPoint: Int,
  marginTop: Float,
) {
  if (marginTop <= 0) return

  // Insert a newline character to act as a vertical spacer
  builder.insert(insertionPoint, "\n")

  // Apply MarginBottomSpan to the spacer character to create the gap before the content
  builder.setSpan(
    MarginBottomSpan(marginTop),
    insertionPoint,
    insertionPoint + 1,
    SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
  )
}

fun applyMarginBottom(
  builder: SpannableStringBuilder,
  marginBottom: Float,
) {
  val spacerStart = builder.length
  builder.append("\n")
  // Always create a MarginBottomSpan, even when marginBottom = 0.
  // This ensures removeTrailingMargin can correctly identify the LAST element's
  // margin value. Without a span on the last element, it would pick up a previous
  // element's span (e.g. blockquote with marginBottom: 16) and use that wrong value.
  builder.setSpan(
    MarginBottomSpan(marginBottom),
    spacerStart,
    builder.length,
    SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
  )
}
