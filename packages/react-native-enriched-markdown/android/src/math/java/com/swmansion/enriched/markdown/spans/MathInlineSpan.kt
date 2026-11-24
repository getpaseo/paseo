package com.swmansion.enriched.markdown.spans

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.text.style.ReplacementSpan
import com.swmansion.enriched.markdown.math.LatexErrorReporter
import io.ratex.RaTeXEngine
import io.ratex.RaTeXFontLoader
import io.ratex.RaTeXRenderer
import kotlin.math.ceil

class MathInlineSpan(
  private val context: Context,
  internal val latex: String,
  internal val fontSize: Float,
  private val textColor: Int,
  private val onLatexError: LatexErrorReporter? = null,
) : ReplacementSpan() {
  private var cachedBitmap: Bitmap? = null
  private var cachedWidth = 0
  private var mathAscent = 0f
  private var mathDescent = 0f
  private var renderFailed = false

  private var fallbackText: String? = null

  private fun prepareResources() {
    if (cachedBitmap != null && !cachedBitmap!!.isRecycled) return
    if (renderFailed) return

    try {
      val displayList = RaTeXEngine.parseBlocking(latex, displayMode = false, color = textColor)
      val renderer = RaTeXRenderer(displayList, fontSize) { RaTeXFontLoader.getTypeface(it) }

      cachedWidth = renderer.widthPx.toInt().coerceAtLeast(1)
      mathAscent = renderer.heightPx
      mathDescent = renderer.depthPx

      val bitmap =
        Bitmap.createBitmap(
          cachedWidth,
          ceil(renderer.totalHeightPx).toInt().coerceAtLeast(1),
          Bitmap.Config.ARGB_8888,
        )

      renderer.draw(Canvas(bitmap))
      cachedBitmap = bitmap
    } catch (e: Exception) {
      renderFailed = true
      fallbackText = "\$" + latex + "\$"
      onLatexError?.report(latex, e.message, false)
    }
  }

  override fun getSize(
    paint: Paint,
    text: CharSequence?,
    start: Int,
    end: Int,
    fm: Paint.FontMetricsInt?,
  ): Int {
    prepareResources()

    val fallback = fallbackText
    if (fallback != null) {
      cachedWidth = ceil(paint.measureText(fallback)).toInt().coerceAtLeast(1)
      fm?.apply {
        val paintFm = paint.fontMetricsInt
        ascent = paintFm.ascent
        top = paintFm.top
        descent = paintFm.descent
        bottom = paintFm.bottom
      }
      return cachedWidth
    }

    fm?.apply {
      val ascentPx = ceil(mathAscent).toInt()
      ascent = -ascentPx
      top = ascent
      descent = (cachedBitmap?.height ?: ceil(mathAscent + mathDescent).toInt()) - ascentPx
      bottom = descent
    }

    return cachedWidth
  }

  override fun draw(
    canvas: Canvas,
    text: CharSequence?,
    start: Int,
    end: Int,
    x: Float,
    top: Int,
    y: Int,
    bottom: Int,
    paint: Paint,
  ) {
    prepareResources()

    val bitmap = cachedBitmap
    if (bitmap != null) {
      val bitmapY = y - ceil(mathAscent)
      canvas.drawBitmap(bitmap, x, bitmapY, paint)
      return
    }

    fallbackText?.let { fallback ->
      val originalColor = paint.color
      paint.color = textColor
      canvas.drawText(fallback, x, y.toFloat(), paint)
      paint.color = originalColor
    }
  }
}
