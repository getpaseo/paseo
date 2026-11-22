package com.swmansion.enriched.markdown.spans

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.TextPaint
import com.facebook.react.common.ReactConstants
import com.facebook.react.views.text.ReactTypefaceUtils.applyStyles
import com.facebook.react.views.text.ReactTypefaceUtils.parseFontWeight
import com.swmansion.enriched.markdown.renderer.BlockStyle
import com.swmansion.enriched.markdown.renderer.SpanStyleCache
import com.swmansion.enriched.markdown.styles.ListStyle
import kotlin.math.ceil

class OrderedListSpan(
  private val listStyle: ListStyle,
  depth: Int,
  context: Context,
  styleCache: SpanStyleCache,
  drawsMarker: Boolean = true,
  override val markerExtraWidth: Float = 0f,
  ancestorMarkerOffset: Float = 0f,
  parentMarkerWidth: Float? = null,
) : BaseListSpan(
    depth = depth,
    context = context,
    styleCache = styleCache,
    blockStyle =
      BlockStyle(
        fontSize = listStyle.fontSize,
        fontFamily = listStyle.fontFamily,
        fontWeight = listStyle.fontWeight,
        color = listStyle.color,
      ),
    marginLeft = listStyle.marginLeft,
    gapWidth = listStyle.gapWidth,
    drawsMarker = drawsMarker,
    ancestorMarkerOffset = ancestorMarkerOffset,
    parentMarkerWidth = parentMarkerWidth,
  ) {
  companion object {
    private val sharedMarkerPaint = TextPaint().apply { isAntiAlias = true }

    /**
     * How far the `99.` column every ordered list reserves must grow to fit each of [numbers].
     * Whole pixels, so the Int leading margins and the float marker positions agree at every depth.
     */
    fun measureExtraWidth(
      listStyle: ListStyle,
      context: Context,
      numbers: Iterable<Int>,
    ): Float {
      val paint = markerPaint(listStyle, markerTypeface(listStyle, context))
      val default = paint.measureText("99.")
      val widest = numbers.fold(default) { width, number -> maxOf(width, paint.measureText("$number.")) }
      return ceil(listStyle.effectiveMarkerWidth(widest) - listStyle.effectiveMarkerWidth(default))
    }

    private fun markerTypeface(
      listStyle: ListStyle,
      context: Context,
    ): Typeface =
      applyStyles(
        null,
        ReactConstants.UNSET,
        parseFontWeight(listStyle.markerFontWeight),
        listStyle.fontFamily.takeIf { it.isNotEmpty() },
        context.assets,
      )

    private fun markerPaint(
      listStyle: ListStyle,
      typeface: Typeface,
    ): TextPaint =
      sharedMarkerPaint.apply {
        textSize = listStyle.fontSize
        color = listStyle.markerColor
        this.typeface = typeface
      }
  }

  private val markerTypeface = markerTypeface(listStyle, context)
  private val defaultMarkerWidth = listStyle.effectiveMarkerWidth(markerPaint(listStyle, markerTypeface).measureText("99."))

  override fun getMarkerWidth(): Float = defaultMarkerWidth + markerExtraWidth

  override val baselineMarkerWidth: Float get() = defaultMarkerWidth

  var itemNumber: Int = 1
    private set

  override fun drawMarker(
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
    val markerPaint = markerPaint(listStyle, markerTypeface)
    val text = if (dir < 0) ".$itemNumber" else "$itemNumber."
    val textWidth = markerPaint.measureText(text)

    val markerRightEdge = x + (depth * marginLeft + ancestorMarkerOffset + getMarkerWidth()) * dir
    val markerX = if (dir > 0) markerRightEdge - textWidth else markerRightEdge

    canvas.drawText(text, markerX, baseline.toFloat(), markerPaint)
  }

  fun setItemNumber(number: Int) {
    itemNumber = number
  }
}
