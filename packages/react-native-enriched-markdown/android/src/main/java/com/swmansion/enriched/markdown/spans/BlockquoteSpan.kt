package com.swmansion.enriched.markdown.spans

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.Spanned
import android.text.TextPaint
import android.text.style.LeadingMarginSpan
import android.text.style.LineBackgroundSpan
import android.text.style.MetricAffectingSpan
import androidx.core.graphics.withSave
import com.swmansion.enriched.markdown.renderer.BlockStyle
import com.swmansion.enriched.markdown.renderer.SpanStyleCache
import com.swmansion.enriched.markdown.styles.BlockquoteStyle
import com.swmansion.enriched.markdown.utils.text.extensions.applyBlockStyleFont
import com.swmansion.enriched.markdown.utils.text.extensions.applyColorPreserving

class BlockquoteSpan(
  private val blockquoteStyle: BlockquoteStyle,
  val depth: Int,
  private val context: Context,
  private val styleCache: SpanStyleCache,
) : MetricAffectingSpan(),
  LeadingMarginSpan,
  LineBackgroundSpan {
  private val levelSpacing: Float = blockquoteStyle.borderWidth + blockquoteStyle.gapWidth
  private val blockStyle =
    BlockStyle(
      fontSize = blockquoteStyle.fontSize,
      fontFamily = blockquoteStyle.fontFamily,
      fontWeight = blockquoteStyle.fontWeight,
      color = blockquoteStyle.color,
    )

  // Cache for shouldSkipDrawing to avoid repeated getSpans() calls during draw passes
  private var cachedText: CharSequence? = null
  private var cachedSpansByPosition = mutableMapOf<Int, Array<BlockquoteSpan>>()
  private var boxLeft = 0f
  private var boxRight = 0f

  private val path = Path()
  private val rect = RectF()
  private val radiiArray = FloatArray(8)

  override fun updateMeasureState(tp: TextPaint) = applyTextStyle(tp)

  override fun updateDrawState(tp: TextPaint) = applyTextStyle(tp)

  override fun getLeadingMargin(first: Boolean): Int = levelSpacing.toInt()

  override fun drawLeadingMargin(
    c: Canvas,
    p: Paint,
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
    // Essential check from original: only the deepest span draws to prevent over-rendering background
    if (shouldSkipDrawing(text, start)) return

    val borderPaint = configureBorderPaint()
    val radius = blockquoteStyle.borderRadius
    val spanned = text as? Spanned

    if (spanned == null) {
      drawBorders(c, x, dir, top, bottom, borderPaint)
      return
    }

    val rootSpan = spanAtMinDepth(spanned, start)
    val clipToRoot =
      radius > 0f && boxRight > boxLeft && rootSpan != null && isBoundaryLine(spanned, start, end, rootSpan)

    val padding = blockquoteStyle.padding
    var topInset = 0f
    var bottomInset = 0f

    for (level in 0..depth) {
      val borderX = x + (levelSpacing * level * dir)
      val borderRight = borderX + (blockquoteStyle.borderWidth * dir)
      val stripeLeft = minOf(borderX, borderRight)
      val stripeRight = maxOf(borderX, borderRight)
      val stripeTop = top.toFloat() + topInset
      val stripeBottom = bottom.toFloat() - bottomInset

      val levelSpan = if (level == 0) rootSpan else spanAtDepth(spanned, start, level)
      val clipToOwn =
        radius > 0f && level > 0 && levelSpan != null && isBoundaryLine(spanned, start, end, levelSpan)

      if (!clipToRoot && !clipToOwn) {
        c.drawRect(stripeLeft, stripeTop, stripeRight, stripeBottom, borderPaint)
      } else {
        c.withSave {
          if (clipToRoot) {
            buildBoundaryPath(spanned, start, end, rootSpan!!, boxLeft, top.toFloat(), boxRight, bottom.toFloat())
            clipPath(path)
          }
          if (clipToOwn) {
            val clipLeft = if (dir >= 0) stripeLeft else boxLeft
            val clipRight = if (dir >= 0) boxRight else stripeRight
            buildBoundaryPath(spanned, start, end, levelSpan!!, clipLeft, stripeTop, clipRight, stripeBottom)
            clipPath(path)
          }
          drawRect(stripeLeft, stripeTop, stripeRight, stripeBottom, borderPaint)
        }
      }

      if (padding > 0 && levelSpan != null) {
        if (start == spanned.getSpanStart(levelSpan)) topInset += padding
        if (isLastLineOf(spanned, end, levelSpan)) bottomInset += padding
      }
    }
  }

  override fun drawBackground(
    canvas: Canvas,
    paint: Paint,
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
    if (shouldSkipDrawing(text, start)) return

    boxLeft = left.toFloat()
    boxRight = right.toFloat()

    val bgColor = blockquoteStyle.backgroundColor?.takeIf { it != Color.TRANSPARENT } ?: return
    val backgroundPaint = configureBackgroundPaint(bgColor)
    val radius = blockquoteStyle.borderRadius
    val rootSpan = (text as? Spanned)?.let { spanAtMinDepth(it, start) }

    if (radius <= 0f || rootSpan == null) {
      canvas.drawRect(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat(), backgroundPaint)
      return
    }

    buildBoundaryPath(text as Spanned, start, end, rootSpan, left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat())
    canvas.drawPath(path, backgroundPaint)
  }

  private fun drawBorders(
    c: Canvas,
    x: Int,
    dir: Int,
    top: Int,
    bottom: Int,
    borderPaint: Paint,
  ) {
    val borderTop = top.toFloat()
    val borderBottom = bottom.toFloat()

    for (level in 0..depth) {
      val borderX = x + (levelSpacing * level * dir)
      val borderRight = borderX + (blockquoteStyle.borderWidth * dir)
      c.drawRect(minOf(borderX, borderRight), borderTop, maxOf(borderX, borderRight), borderBottom, borderPaint)
    }
  }

  @SuppressLint("WrongConstant") // Result of mask is always valid: 0, 1, 2, or 3
  private fun applyTextStyle(tp: TextPaint) {
    tp.textSize = blockStyle.fontSize
    val preserved = (tp.typeface?.style ?: 0) and BOLD_ITALIC_MASK
    tp.applyBlockStyleFont(blockStyle, context)
    if (preserved != 0) {
      tp.typeface = Typeface.create(tp.typeface ?: Typeface.DEFAULT, preserved)
    }
    tp.applyColorPreserving(blockStyle.color, *styleCache.colorsToPreserve)
  }

  companion object {
    private const val BOLD_ITALIC_MASK = Typeface.BOLD or Typeface.ITALIC

    private val sharedBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val sharedBackgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  }

  private fun configureBorderPaint(): Paint =
    sharedBorderPaint.apply {
      color = blockquoteStyle.borderColor
    }

  private fun configureBackgroundPaint(bgColor: Int): Paint =
    sharedBackgroundPaint.apply {
      color = bgColor
    }

  private fun spansAt(
    text: Spanned,
    start: Int,
  ): Array<BlockquoteSpan> {
    if (cachedText !== text) {
      cachedText = text
      cachedSpansByPosition.clear()
    }
    return cachedSpansByPosition.getOrPut(start) {
      text.getSpans(start, start + 1, BlockquoteSpan::class.java)
    }
  }

  private fun shouldSkipDrawing(
    text: CharSequence?,
    start: Int,
  ): Boolean {
    if (text !is Spanned) return false
    val maxDepth = spansAt(text, start).maxOfOrNull { it.depth } ?: -1
    return maxDepth > depth
  }

  private fun spanAtMinDepth(
    text: Spanned,
    start: Int,
  ): BlockquoteSpan? = spansAt(text, start).minByOrNull { it.depth }

  private fun spanAtDepth(
    text: Spanned,
    start: Int,
    level: Int,
  ): BlockquoteSpan? = spansAt(text, start).firstOrNull { it.depth == level }

  /**
   * The span range can include trailing '\n'(s) that form no visible line (e.g. a
   * paragraph break closing the quote), so the last drawn line ends before getSpanEnd;
   * this compares against the end of visible content instead.
   */
  private fun isLastLineOf(
    text: Spanned,
    lineEnd: Int,
    box: BlockquoteSpan,
  ): Boolean {
    var boxEnd = text.getSpanEnd(box)
    while (boxEnd > 0 && text[boxEnd - 1] == '\n') {
      boxEnd--
    }
    return lineEnd >= boxEnd
  }

  private fun isBoundaryLine(
    text: Spanned,
    lineStart: Int,
    lineEnd: Int,
    box: BlockquoteSpan,
  ): Boolean {
    val boxStart = text.getSpanStart(box)
    val boxEnd = text.getSpanEnd(box)
    if (boxStart !in 0 until boxEnd) return false
    return lineStart == boxStart || isLastLineOf(text, lineEnd, box)
  }

  private fun buildBoundaryPath(
    text: Spanned,
    lineStart: Int,
    lineEnd: Int,
    box: BlockquoteSpan,
    left: Float,
    top: Float,
    right: Float,
    bottom: Float,
  ) {
    val boxStart = text.getSpanStart(box)

    val isFirstLine = lineStart == boxStart
    val isLastLine = isLastLineOf(text, lineEnd, box)

    val radius = blockquoteStyle.borderRadius
    radiiArray.fill(0f)
    if (isFirstLine) {
      radiiArray[0] = radius
      radiiArray[1] = radius // Top-Left
      radiiArray[2] = radius
      radiiArray[3] = radius // Top-Right
    }
    if (isLastLine) {
      radiiArray[4] = radius
      radiiArray[5] = radius // Bottom-Right
      radiiArray[6] = radius
      radiiArray[7] = radius // Bottom-Left
    }

    rect.set(left, top, right, bottom)
    path.reset()
    path.addRoundRect(rect, radiiArray, Path.Direction.CW)
  }
}
