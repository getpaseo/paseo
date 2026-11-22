package com.swmansion.enriched.markdown.spans

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.Spanned
import android.text.TextPaint
import android.text.style.LeadingMarginSpan
import android.text.style.MetricAffectingSpan
import com.swmansion.enriched.markdown.renderer.BlockStyle
import com.swmansion.enriched.markdown.renderer.SpanStyleCache
import com.swmansion.enriched.markdown.utils.text.extensions.applyBlockStyleFont
import com.swmansion.enriched.markdown.utils.text.extensions.applyColorPreserving

abstract class BaseListSpan(
  val depth: Int,
  protected val context: Context,
  protected val styleCache: SpanStyleCache,
  protected val blockStyle: BlockStyle,
  protected val marginLeft: Float,
  protected val gapWidth: Float,
  internal val drawsMarker: Boolean = true,
) : MetricAffectingSpan(),
  LeadingMarginSpan {
  private var cachedText: CharSequence? = null
  private var cachedHasDeeperSpanByPosition = mutableMapOf<Int, Boolean>()

  val markerFontMetrics: Paint.FontMetrics by lazy {
    TextPaint()
      .apply {
        applyBlockStyleFont(blockStyle, context)
        textSize = blockStyle.fontSize
      }.fontMetrics
  }

  protected abstract fun getMarkerWidth(): Float

  override fun updateMeasureState(textPaint: TextPaint) = applyTextStyle(textPaint)

  override fun updateDrawState(textPaint: TextPaint) = applyTextStyle(textPaint)

  override fun getLeadingMargin(first: Boolean): Int =
    if (depth == 0) {
      val effectiveGap = gapWidth.coerceAtLeast(DEFAULT_MIN_GAP)
      (getMarkerWidth() + effectiveGap).toInt()
    } else {
      marginLeft.toInt()
    }

  override fun drawLeadingMargin(
    canvas: Canvas,
    paint: Paint,
    x: Int,
    dir: Int,
    top: Int,
    baseline: Int,
    bottom: Int,
    text: CharSequence?,
    start: Int,
    end: Int,
    first: Boolean,
    layout: Layout?,
  ) {
    if (!drawsMarker) return
    if (!first || shouldSkipDrawing(text, start) || !hasContent(text, start, end)) return

    // Only draw the marker on the true first line of this span.
    // \n inside list item content creates inner paragraphs, each with first=true,
    // but only the line at the span start should get a bullet/number.
    if (text is Spanned && text.getSpanStart(this) != start) return

    drawMarkerAt(canvas, paint, x, dir, top, baseline, bottom, layout, start)
  }

  fun drawMarkerAt(
    canvas: Canvas,
    paint: Paint,
    x: Int,
    dir: Int,
    top: Int,
    baseline: Int,
    bottom: Int,
    layout: Layout?,
    start: Int,
  ) {
    val originalStyle = paint.style
    val originalColor = paint.color
    drawMarker(canvas, paint, x, dir, top, baseline, bottom, layout, start)
    paint.style = originalStyle
    paint.color = originalColor
  }

  protected abstract fun drawMarker(
    canvas: Canvas,
    paint: Paint,
    x: Int,
    dir: Int,
    top: Int,
    baseline: Int,
    bottom: Int,
    layout: Layout?,
    start: Int,
  )

  @SuppressLint("WrongConstant")
  private fun applyTextStyle(textPaint: TextPaint) {
    textPaint.textSize = blockStyle.fontSize

    val preservedStyle = (textPaint.typeface?.style ?: 0) and BOLD_ITALIC_MASK
    textPaint.applyBlockStyleFont(blockStyle, context)
    if (preservedStyle != 0) {
      textPaint.typeface?.let { base -> textPaint.typeface = Typeface.create(base, preservedStyle) }
    }

    textPaint.applyColorPreserving(blockStyle.color, *styleCache.colorsToPreserve)
  }

  companion object {
    private const val BOLD_ITALIC_MASK = Typeface.BOLD or Typeface.ITALIC
    private const val DEFAULT_MIN_GAP = 4f
  }

  private fun hasContent(
    text: CharSequence?,
    start: Int,
    end: Int,
  ): Boolean {
    if (text == null || end <= start) return false
    return (start until end).any { !text[it].isWhitespace() }
  }

  private fun shouldSkipDrawing(
    text: CharSequence?,
    start: Int,
  ): Boolean {
    if (text !is Spanned) return false

    if (cachedText !== text) {
      cachedText = text
      cachedHasDeeperSpanByPosition.clear()
    }

    return cachedHasDeeperSpanByPosition.getOrPut(start) {
      val spans = text.getSpans(start, start + 1, BaseListSpan::class.java)
      spans.any { it.depth > depth }
    }
  }
}
