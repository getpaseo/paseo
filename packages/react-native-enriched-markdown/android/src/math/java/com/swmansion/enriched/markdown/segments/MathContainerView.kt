package com.swmansion.enriched.markdown.segments

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import com.swmansion.enriched.markdown.accessibility.AccessibilityLabels
import com.swmansion.enriched.markdown.math.LatexErrorReporter
import com.swmansion.enriched.markdown.spans.MathMeasureHelper
import com.swmansion.enriched.markdown.spans.MathMeasureRequest
import com.swmansion.enriched.markdown.spans.MathRenderMode
import com.swmansion.enriched.markdown.styles.MathStyle
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.views.ContextMenuPopup
import io.ratex.RaTeXEngine
import io.ratex.RaTeXFontLoader
import io.ratex.RaTeXRenderer
import kotlin.math.ceil

class MathContainerView(
  context: Context,
  styleConfig: StyleConfig,
) : FrameLayout(context),
  BlockSegmentView {
  private val mathStyle: MathStyle = styleConfig.mathStyle
  private val scrollView = HorizontalScrollView(context)
  private var cachedLatex: String = ""

  var accessibilityLabels: AccessibilityLabels = AccessibilityLabels()
    set(value) {
      field = value
      updateAccessibilityLabel()
    }
  var dynamicProps: DynamicBlockProps = DynamicBlockProps()
  var onLatexError: LatexErrorReporter? = null

  override val segmentMarginTop: Int get() = mathStyle.marginTop.toInt()
  override val segmentMarginBottom: Int get() = mathStyle.marginBottom.toInt()

  private val mathGravity =
    when (mathStyle.textAlign) {
      "left" -> Gravity.START
      "right" -> Gravity.END
      else -> Gravity.CENTER_HORIZONTAL
    }

  private val mathView = RaTeXCanvasView(context)

  init {
    setBackgroundColor(mathStyle.backgroundColor)

    val paddingPx = mathStyle.padding.toInt()

    RaTeXFontLoader.ensureLoaded(context)

    val mathLayoutParams =
      FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply {
        gravity = mathGravity
      }

    val mathWrapper =
      FrameLayout(context).apply {
        setPadding(paddingPx, paddingPx, paddingPx, paddingPx)
      }
    mathWrapper.addView(mathView, mathLayoutParams)

    scrollView.apply {
      isHorizontalScrollBarEnabled = true
      overScrollMode = View.OVER_SCROLL_NEVER
      isFillViewport = true
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      addView(mathWrapper, LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
    }

    addView(scrollView, LayoutParams(MATCH_PARENT, WRAP_CONTENT))

    isFocusable = true
    isScreenReaderFocusable = true
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    updateAccessibilityLabel()

    setOnLongClickListener { view -> showContextMenu(view) }
    mathView.setOnLongClickListener { view -> showContextMenu(view) }
  }

  fun applyLatex(latex: String) {
    cachedLatex = latex
    try {
      val displayList = RaTeXEngine.parseBlocking(latex, displayMode = true, color = mathStyle.color)
      mathView.renderer = RaTeXRenderer(displayList, mathStyle.fontSize) { RaTeXFontLoader.getTypeface(it) }
      mathView.fallbackText = null
    } catch (e: Exception) {
      Log.e(TAG, "Failed to render LaTeX", e)
      mathView.renderer = null
      mathView.fallbackText = "\$\$" + latex + "\$\$"
      mathView.fallbackColor = mathStyle.color
      mathView.fallbackFontSize = mathStyle.fontSize
      onLatexError?.report(latex, e.message, true)
    }
    mathView.requestLayout()
    mathView.invalidate()
    updateAccessibilityLabel()
  }

  private fun updateAccessibilityLabel() {
    contentDescription = accessibilityLabels.mathEquation.replace("{latex}", cachedLatex)
  }

  private fun showContextMenu(anchor: View): Boolean {
    if (!dynamicProps.enableBlockContextMenu) return false
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    ContextMenuPopup.show(anchor, this) {
      item(ContextMenuPopup.Icon.COPY, dynamicProps.copyLabel) {
        clipboard.setPrimaryClip(ClipData.newPlainText("Math", cachedLatex))
      }
      item(ContextMenuPopup.Icon.DOCUMENT, dynamicProps.copyAsMarkdownLabel) {
        clipboard.setPrimaryClip(ClipData.newPlainText("Math", "$$\n$cachedLatex\n$$"))
      }
    }
    return true
  }

  private class RaTeXCanvasView(
    context: Context,
  ) : View(context) {
    var renderer: RaTeXRenderer? = null

    var fallbackText: String? = null
    var fallbackColor: Int = 0
    var fallbackFontSize: Float = 0f
    private val fallbackPaint = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun onMeasure(
      widthMeasureSpec: Int,
      heightMeasureSpec: Int,
    ) {
      val currentRenderer = renderer
      if (currentRenderer != null) {
        setMeasuredDimension(
          ceil(currentRenderer.widthPx).toInt().coerceAtLeast(1),
          ceil(currentRenderer.totalHeightPx).toInt().coerceAtLeast(1),
        )
        return
      }

      val fallback = fallbackText
      if (fallback != null) {
        fallbackPaint.textSize = fallbackFontSize
        val metrics = fallbackPaint.fontMetrics
        setMeasuredDimension(
          ceil(fallbackPaint.measureText(fallback)).toInt().coerceAtLeast(1),
          ceil(metrics.descent - metrics.ascent).toInt().coerceAtLeast(1),
        )
        return
      }

      setMeasuredDimension(0, 0)
    }

    override fun onDraw(canvas: Canvas) {
      val currentRenderer = renderer
      if (currentRenderer != null) {
        currentRenderer.draw(canvas)
        return
      }

      val fallback = fallbackText ?: return
      fallbackPaint.textSize = fallbackFontSize
      fallbackPaint.color = fallbackColor
      canvas.drawText(fallback, 0f, -fallbackPaint.fontMetrics.ascent, fallbackPaint)
    }
  }

  companion object {
    fun measureMathHeight(
      latex: String,
      mathStyle: MathStyle,
      context: Context,
    ): Float {
      val request =
        MathMeasureRequest(
          fontSize = mathStyle.fontSize,
          latex = latex,
          mode = MathRenderMode.Display,
        )
      val metrics = MathMeasureHelper.measure(context, listOf(request)).first()
      return ceil(metrics.ascent + metrics.descent).toInt() + (mathStyle.padding * 2)
    }

    private const val TAG = "MathContainerView"
  }
}
