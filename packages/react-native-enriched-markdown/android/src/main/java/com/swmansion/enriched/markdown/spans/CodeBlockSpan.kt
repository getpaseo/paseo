package com.swmansion.enriched.markdown.spans

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.text.Layout
import android.text.Spanned
import android.text.TextPaint
import android.text.style.LeadingMarginSpan
import android.text.style.LineBackgroundSpan
import android.text.style.MetricAffectingSpan
import androidx.core.graphics.withSave
import com.swmansion.enriched.markdown.renderer.SpanStyleCache
import com.swmansion.enriched.markdown.styles.CodeBlockStyle
import com.swmansion.enriched.markdown.utils.text.extensions.applyCodeBlockTextStyle
import com.swmansion.enriched.markdown.utils.text.extensions.applyColorPreserving

/**
 * Draws the commonmark-flavor code block box as per-line strips. The visual
 * conventions (half-stroke border inset, radius reduced by that inset) must
 * stay in sync with the whole-rect box the github flavor draws in
 * CodeBlockContainerView.
 */
class CodeBlockSpan(
  private val codeBlockStyle: CodeBlockStyle,
  private val context: Context,
  private val styleCache: SpanStyleCache,
  private val leadingIndent: Int = 0,
  // Recovered by a tap on this span for onCodeBlockPress; unused by drawing.
  val code: String = "",
  val language: String = "",
) : MetricAffectingSpan(),
  LineBackgroundSpan,
  LeadingMarginSpan {
  private val path = Path()
  private val rect = RectF()
  private val arcRect = RectF()
  private val radiiArray = FloatArray(8)

  companion object {
    private val sharedBackgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val sharedBorderPaint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.BUTT
        strokeJoin = Paint.Join.ROUND
      }
  }

  private fun configureBackgroundPaint(): Paint =
    sharedBackgroundPaint.apply {
      color = codeBlockStyle.backgroundColor
    }

  private fun configureBorderPaint(): Paint =
    sharedBorderPaint.apply {
      strokeWidth = codeBlockStyle.borderWidth
      color = codeBlockStyle.borderColor
    }

  override fun getLeadingMargin(first: Boolean): Int = codeBlockStyle.padding.toInt() + leadingIndent

  override fun drawLeadingMargin(
    c: Canvas?,
    p: Paint?,
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
  ) { /* Leading margin is handled by getLeadingMargin */ }

  override fun updateMeasureState(tp: TextPaint) = applyTextStyle(tp)

  override fun updateDrawState(tp: TextPaint) = applyTextStyle(tp)

  override fun drawBackground(
    canvas: Canvas,
    p: Paint,
    left: Int,
    right: Int,
    top: Int,
    baseline: Int,
    bottom: Int,
    text: CharSequence,
    start: Int,
    end: Int,
    lineNum: Int,
  ) {
    if (text !is Spanned) return

    val spanStart = text.getSpanStart(this)
    val spanEnd = text.getSpanEnd(this)
    if (spanStart !in 0 until spanEnd) return

    val isFirstLine = start == spanStart
    val isLastLine = end == spanEnd || (spanEnd <= end && (spanEnd == text.length || text[spanEnd - 1] == '\n'))

    val inset = codeBlockStyle.borderWidth / 2f

    rect.set(
      left.toFloat() + leadingIndent + inset,
      top.toFloat() + (if (isFirstLine) inset else 0f),
      right.toFloat() - inset,
      bottom.toFloat() - (if (isLastLine) inset else 0f),
    )
    if (rect.left >= rect.right) return

    val radius = codeBlockStyle.borderRadius
    val adjRadius = if (radius > inset) radius - inset else radius

    // Reset and fill radii array based on boundary state
    radiiArray.fill(0f)
    if (isFirstLine) {
      radiiArray[0] = adjRadius
      radiiArray[1] = adjRadius // Top-Left
      radiiArray[2] = adjRadius
      radiiArray[3] = adjRadius // Top-Right
    }
    if (isLastLine) {
      radiiArray[4] = adjRadius
      radiiArray[5] = adjRadius // Bottom-Right
      radiiArray[6] = adjRadius
      radiiArray[7] = adjRadius // Bottom-Left
    }

    path.reset()
    path.addRoundRect(rect, radiiArray, Path.Direction.CW)

    val backgroundPaint = configureBackgroundPaint()
    val borderPaint = configureBorderPaint()

    canvas.withSave {
      drawPath(path, backgroundPaint)

      if (codeBlockStyle.borderWidth > 0) {
        val bLeft = rect.left
        val bRight = rect.right
        val bTop = rect.top
        val bBottom = rect.bottom

        when {
          // Case: Single-line code block
          isFirstLine && isLastLine -> {
            drawPath(path, borderPaint)
          }

          // Case: Top of a multi-line block
          isFirstLine -> {
            drawLine(bLeft + adjRadius, bTop, bRight - adjRadius, bTop, borderPaint)
            drawLine(bLeft, bTop + adjRadius, bLeft, bBottom, borderPaint)
            drawLine(bRight, bTop + adjRadius, bRight, bBottom, borderPaint)

            arcRect.set(bLeft, bTop, bLeft + 2 * adjRadius, bTop + 2 * adjRadius)
            drawArc(arcRect, 180f, 90f, false, borderPaint)

            arcRect.set(bRight - 2 * adjRadius, bTop, bRight, bTop + 2 * adjRadius)
            drawArc(arcRect, 270f, 90f, false, borderPaint)
          }

          // Case: Bottom of a multi-line block
          isLastLine -> {
            drawLine(bLeft + adjRadius, bBottom, bRight - adjRadius, bBottom, borderPaint)
            drawLine(bLeft, bTop, bLeft, bBottom - adjRadius, borderPaint)
            drawLine(bRight, bTop, bRight, bBottom - adjRadius, borderPaint)

            arcRect.set(bLeft, bBottom - 2 * adjRadius, bLeft + 2 * adjRadius, bBottom)
            drawArc(arcRect, 90f, 90f, false, borderPaint)

            arcRect.set(bRight - 2 * adjRadius, bBottom - 2 * adjRadius, bRight, bBottom)
            drawArc(arcRect, 0f, 90f, false, borderPaint)
          }

          // Case: Middle lines only need vertical sides
          else -> {
            drawLine(bLeft, bTop, bLeft, bBottom, borderPaint)
            drawLine(bRight, bTop, bRight, bBottom, borderPaint)
          }
        }
      }
    }
  }

  private fun applyTextStyle(tp: TextPaint) {
    tp.applyCodeBlockTextStyle(codeBlockStyle, context)

    tp.applyColorPreserving(codeBlockStyle.color, *styleCache.colorsToPreserve)
  }
}
