package com.swmansion.enriched.markdown.input.spans

import android.graphics.Paint
import android.graphics.Paint.FontMetricsInt
import android.text.Spannable
import android.text.Spanned
import android.text.style.LineHeightSpan
import android.text.style.UpdateLayout
import com.facebook.react.views.text.TextAttributes
import com.swmansion.enriched.markdown.utils.text.span.applyLineHeight
import kotlin.math.ceil

/**
 * Body line height for the whole input, using the same half-leading metrics as
 * React Native's CustomLineHeightSpan.
 *
 * applyFormatting strips and re-adds this span when lists or headings
 * change. EditText rebuilds DynamicLayout only for UpdateLayout (or
 * MetricAffectingSpan) spans so we need to include UpdateLayout to ensure that
 * this happens.
 *
 * Headings apply their own LineHeightSpan at default priority after
 * this one; we don't apply our height to heading lines to avoid any
 * conflicts.
 */
internal class InputLineHeightSpan(
  lineHeightPx: Float,
) : LineHeightSpan,
  UpdateLayout {
  private val lineHeight: Int = ceil(lineHeightPx.toDouble()).toInt()

  override fun chooseHeight(
    text: CharSequence,
    start: Int,
    end: Int,
    spanstartv: Int,
    v: Int,
    fm: FontMetricsInt,
  ) {
    // Don't override the InputHeadingSpan's lineHeight. applyLineHeight
    // applies the maximum of all applied lineHeights, so we skip this so
    // a greater lineHeight from an InputLineHeightSpan won't override the
    // heading's lineHeight.
    if (text is Spanned && text.getSpans(start, end, InputHeadingSpan::class.java).isNotEmpty()) return
    applyLineHeight(fm, lineHeight, start, end, text.length)
  }
}

/**
 * Replaces the body line-height span on [text], like the CustomLineHeightSpan
 * that React Native's addSpansFromStyleAttributes adds for TextInput:
 * https://github.com/react/react-native/blob/v0.86.2/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactEditText.kt#L793-L859
 *
 * React Native also adds font size, color and typeface spans there because
 * its TextLayoutManager measures with a shared paint. The editor draws with
 * its own paint, and InputMeasurementStore measures with a snapshot of it, so
 * line height is the only base style that has to live on the text.
 */
internal fun applyBodyLineHeightSpan(
  text: Spannable,
  textAttributes: TextAttributes,
) {
  text.getSpans(0, text.length, InputLineHeightSpan::class.java).forEach { text.removeSpan(it) }

  val lineHeight = textAttributes.effectiveLineHeight
  if (text.isEmpty() || lineHeight.isNaN()) return

  // SPAN_PRIORITY gives the lowest precedence, so heading line heights and
  // other markdown spans win over the body line height.
  text.setSpan(
    InputLineHeightSpan(lineHeight),
    0,
    text.length,
    Spannable.SPAN_INCLUSIVE_INCLUSIVE or Spannable.SPAN_PRIORITY,
  )
}

/**
 * Keeps the body line-height span covering all of [text] while typing.
 * Typing runs inline and block formatting but not [applyBodyLineHeightSpan].
 *
 * SPAN_INCLUSIVE_INCLUSIVE stretches an existing span over typed text, so most
 * keystrokes return early here without re-adding the span (re-adding an
 * UpdateLayout span reflows the whole layout). The span is missing when the
 * input mounted empty or applyFormatting() last ran on an empty buffer, so the
 * first character typed adds it.
 */
internal fun ensureBodyLineHeightSpan(
  text: Spannable,
  textAttributes: TextAttributes,
) {
  if (text.isEmpty() || textAttributes.effectiveLineHeight.isNaN()) return

  val spans = text.getSpans(0, text.length, InputLineHeightSpan::class.java)
  val coversText =
    spans.size == 1 &&
      text.getSpanStart(spans[0]) == 0 &&
      text.getSpanEnd(spans[0]) == text.length
  if (!coversText) applyBodyLineHeightSpan(text, textAttributes)
}

/**
 * Font metrics for a body line at the body line height, for
 * setMinimumFontMetrics (Android 15+).
 *
 * We calculate this based on the current line height, and then
 * setMinimumFontMetrics with this so that empty lines have the correct
 * line-height too. By default, empty lines don't apply our
 * InputLineHeightSpan, so this is the simplest way to ensure they have the
 * correct line-height too.
 */
internal fun bodyLineMinimumFontMetrics(
  paint: Paint,
  textAttributes: TextAttributes,
): Paint.FontMetrics? {
  val lineHeight = textAttributes.effectiveLineHeight
  if (lineHeight.isNaN()) return null

  val fm = paint.fontMetricsInt
  // start == 0 and end == textLength: drop the top/bottom padding, as for the
  // only line of a text.
  applyLineHeight(fm, ceil(lineHeight.toDouble()).toInt(), start = 0, end = 0, textLength = 0)
  return Paint.FontMetrics().apply {
    top = fm.top.toFloat()
    ascent = fm.ascent.toFloat()
    descent = fm.descent.toFloat()
    bottom = fm.bottom.toFloat()
  }
}
