package com.swmansion.enriched.markdown.segments

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.Layout
import android.text.SpannableString
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.util.TypedValue
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import androidx.appcompat.widget.AppCompatTextView
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.spans.LineHeightSpan
import com.swmansion.enriched.markdown.styles.CodeBlockStyle
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.utils.common.CodeBlockHighlighter
import com.swmansion.enriched.markdown.utils.common.CodeBlockNode
import com.swmansion.enriched.markdown.utils.text.extensions.applyCodeBlockTextStyle
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE
import com.swmansion.enriched.markdown.views.ClaimingHorizontalScrollView
import com.swmansion.enriched.markdown.views.ContextMenuPopup
import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * Block segment view for fenced code blocks (see splitASTIntoSegments):
 * a fixed header bar (language name, copy button) above a horizontally
 * scrolling, non-wrapping code pane. Syntax coloring comes from the
 * CodeBlockHighlighter seam and falls back to plain text. The box visuals
 * must stay in sync with the commonmark flavor's CodeBlockSpan.
 *
 * measureCodeBlockNodeHeight must stay in sync with the view: it builds the
 * same styled text, paint, and header metrics, so the height reported to
 * Yoga matches the laid-out height. Since lines never wrap, the height is
 * independent of the available width.
 */
class CodeBlockContainerView(
  context: Context,
  styleConfig: StyleConfig,
) : FrameLayout(context),
  BlockSegmentView {
  private val codeBlockStyle: CodeBlockStyle = styleConfig.codeBlockStyle

  private val inset = contentInset(codeBlockStyle)
  private val borderW = borderPx(codeBlockStyle)
  private val headerH = headerHeight(codeBlockStyle)

  override val segmentMarginTop: Int get() = codeBlockStyle.marginTop.toInt()
  override val segmentMarginBottom: Int get() = codeBlockStyle.marginBottom.toInt()

  // Shared, runtime-mutable block props read live at use-time (menu-open, tap);
  // the root mutates the one instance in place, so this view and any sibling
  // created later see the same current values. See DynamicBlockProps.
  var dynamicProps: DynamicBlockProps = DynamicBlockProps()
    set(value) {
      field = value
      syncCopyLabel()
    }

  private var code: String = ""
  private var language: String? = null
  private var fenceChar: String = "`"

  // True until the closing fence arrives: highlighting is deferred and copying
  // is disabled, while the header stays visible.
  var pending: Boolean = false
    set(value) {
      if (field == value) return
      field = value
      copyButton.isEnabled = !value
      // The reconciler can reuse an unchanged block without re-applying the
      // node, so re-derive here to pick up highlighting once the block closes.
      rebuildCodeText()
    }

  private val textView =
    AppCompatTextView(context).apply {
      includeFontPadding = false
      setLineSpacing(0f, 1f)
      breakStrategy = Layout.BREAK_STRATEGY_SIMPLE
      hyphenationFrequency = Layout.HYPHENATION_FREQUENCY_NONE
      layoutDirection = View.LAYOUT_DIRECTION_LTR
      textDirection = View.TEXT_DIRECTION_LTR
      setTextSize(TypedValue.COMPLEX_UNIT_PX, codeBlockStyle.fontSize)
      typeface = createCodePaint(codeBlockStyle, context).typeface
      setTextColor(codeBlockStyle.color)
      val horizontalPad = (inset - borderW).coerceAtLeast(0)
      setPadding(horizontalPad, inset, horizontalPad, inset)
      setOnLongClickListener { view -> showContextMenu(view) }
    }

  private val scrollView =
    ClaimingHorizontalScrollView(context).apply {
      isHorizontalScrollBarEnabled = true
      overScrollMode = View.OVER_SCROLL_NEVER
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        horizontalScrollbarThumbDrawable =
          GradientDrawable().apply {
            setColor(secondaryColor(codeBlockStyle.color))
            cornerRadius = context.resources.displayMetrics.density * 2
          }
      }
      addView(textView, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    }

  private val languageView =
    AppCompatTextView(context).apply {
      includeFontPadding = false
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
      setTextSize(TypedValue.COMPLEX_UNIT_PX, codeBlockStyle.fontSize * HEADER_LABEL_SCALE)
      typeface = headerTypeface
      setTextColor(secondaryColor(codeBlockStyle.color))
    }

  private val copyButton =
    HeaderCopyButton(context, codeBlockStyle).apply {
      contentDescription = dynamicProps.copyLabel
      setOnClickListener { copyCode() }
    }

  private val dividerPaint =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = dividerColor(codeBlockStyle.color)
      strokeWidth = context.resources.displayMetrics.density
    }

  private val tapDetector =
    GestureDetector(
      context,
      object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent): Boolean = true

        override fun onSingleTapUp(e: MotionEvent): Boolean {
          if (isPointInsideCopyButton(e.x, e.y)) return false
          handleCodeBlockPress()
          return false
        }
      },
    )

  init {
    setWillNotDraw(false)
    background =
      GradientDrawable().apply {
        setColor(codeBlockStyle.backgroundColor)
        cornerRadius = codeBlockStyle.borderRadius
        if (codeBlockStyle.borderWidth > 0f) {
          setStroke(ceil(codeBlockStyle.borderWidth).toInt(), codeBlockStyle.borderColor)
        }
      }
    isLongClickable = true
    setOnLongClickListener { view -> showContextMenu(view) }
    addView(scrollView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(languageView, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    addView(copyButton, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
  }

  internal fun syncCopyLabel() {
    copyButton.contentDescription = dynamicProps.copyLabel
  }

  fun applyCodeBlockNode(node: MarkdownASTNode) {
    code = CodeBlockNode.extractCode(node)
    fenceChar = CodeBlockNode.fenceChar(node)
    syncCopyLabel()

    val newLanguage = CodeBlockNode.language(node)
    if (newLanguage != language) {
      language = newLanguage
      languageView.text = CodeBlockNode.displayLanguageName(newLanguage)
    }

    rebuildCodeText()
  }

  // Highlighting is deferred while pending, applied once the block closes.
  private fun rebuildCodeText() {
    val plainCode = buildCodeText(code, codeBlockStyle)
    if (!pending) {
      CodeBlockHighlighter.highlight(plainCode, code, language, codeBlockStyle)
    }
    textView.text = plainCode
  }

  override fun onMeasure(
    widthSpec: Int,
    heightSpec: Int,
  ) {
    val measuredWidth = MeasureSpec.getSize(widthSpec)
    scrollView.measure(
      MeasureSpec.makeMeasureSpec((measuredWidth - borderW * 2).coerceAtLeast(0), MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
    )
    copyButton.measureInBand()
    val labelMaxWidth = (measuredWidth - inset * 2 - headerH).coerceAtLeast(0)
    languageView.measure(
      MeasureSpec.makeMeasureSpec(labelMaxWidth, MeasureSpec.AT_MOST),
      MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
    )
    setMeasuredDimension(measuredWidth, headerH + scrollView.measuredHeight)
  }

  override fun onLayout(
    changed: Boolean,
    left: Int,
    top: Int,
    right: Int,
    bottom: Int,
  ) {
    val width = right - left
    val headerCenterY = copyButton.bandCenterY
    val labelTop = (headerCenterY - languageView.measuredHeight / 2f).roundToInt()
    languageView.layout(
      inset,
      labelTop,
      inset + languageView.measuredWidth,
      labelTop + languageView.measuredHeight,
    )

    copyButton.layoutInBand(width)

    scrollView.layout(borderW, headerH, width - borderW, bottom - top - borderW)
  }

  // Divider between the header and the code, centered in the gap the code
  // text's top inset creates, so it adds no height of its own.
  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val borderWidth = borderW.toFloat()
    val y = headerH + inset / 2f
    canvas.drawLine(borderWidth, y, width - borderWidth, y, dividerPaint)
  }

  // Returns whether a menu was shown, so the long-press listener only consumes
  // the event when there is one (a pending block has no menu yet).
  private fun showContextMenu(anchor: View): Boolean {
    if (!dynamicProps.enableBlockContextMenu || pending) return false
    ContextMenuPopup.show(anchor, this) {
      item(ContextMenuPopup.Icon.COPY, dynamicProps.copyLabel) { copyCode() }
      item(ContextMenuPopup.Icon.DOCUMENT, dynamicProps.copyAsMarkdownLabel) { copyFencedMarkdown() }
    }
    return true
  }

  private fun copyCode() {
    if (pending || code.isEmpty()) return
    copyToClipboard(code)
    dynamicProps.onCopyPress?.invoke(code, language ?: "")
  }

  private fun handleCodeBlockPress() {
    if (!dynamicProps.enableCodeBlockPress || pending) return
    dynamicProps.onCodeBlockPress?.invoke(code, language ?: "")
  }

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    tapDetector.onTouchEvent(ev)
    return super.dispatchTouchEvent(ev)
  }

  private fun isPointInsideCopyButton(
    x: Float,
    y: Float,
  ): Boolean = x >= copyButton.left && x < copyButton.right && y >= copyButton.top && y < copyButton.bottom

  private fun copyFencedMarkdown() {
    if (code.isEmpty()) return
    copyToClipboard(CodeBlockNode.fencedMarkdown(code, language, fenceChar))
  }

  private fun copyToClipboard(text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("Code", text))
  }

  companion object {
    private const val HEADER_LABEL_SCALE = 0.85f

    private val headerTypeface: Typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)

    internal fun secondaryColor(color: Int): Int = (color and 0x00FFFFFF) or (0x99 shl 24)

    private fun dividerColor(color: Int): Int = (color and 0x00FFFFFF) or (0x33 shl 24)

    internal fun contentInset(style: CodeBlockStyle): Int = ceil(style.padding + style.borderWidth).toInt()

    private fun borderPx(style: CodeBlockStyle): Int = ceil(style.borderWidth).toInt()

    // Header is the top content inset plus one label line; the code text
    // view's own top inset then forms the single gap below the label.
    internal fun headerHeight(style: CodeBlockStyle): Int {
      val paint =
        TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
          textSize = style.fontSize * HEADER_LABEL_SCALE
          typeface = headerTypeface
        }
      val metrics = paint.fontMetrics
      return contentInset(style) + ceil(metrics.descent - metrics.ascent).toInt()
    }

    private fun createCodePaint(
      style: CodeBlockStyle,
      context: Context,
    ): TextPaint =
      TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        applyCodeBlockTextStyle(style, context)
      }

    private fun buildCodeText(
      code: String,
      style: CodeBlockStyle,
    ): SpannableString =
      SpannableString(code).apply {
        if (style.lineHeight > 0f && isNotEmpty()) {
          setSpan(LineHeightSpan(style.lineHeight), 0, length, SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE)
        }
      }

    // Lines never wrap (the code pane scrolls horizontally), so the layout is
    // built at the text's desired width and the result is independent of the
    // available width.
    fun measureCodeBlockNodeHeight(
      node: MarkdownASTNode,
      config: StyleConfig,
      context: Context,
      @Suppress("unused") width: Float,
    ): Float {
      val style = config.codeBlockStyle
      val inset = contentInset(style)
      val headerH = headerHeight(style)
      val text = buildCodeText(CodeBlockNode.extractCode(node), style)
      if (text.isEmpty()) return headerH + inset * 2f
      val paint = createCodePaint(style, context)
      val contentWidth = ceil(Layout.getDesiredWidth(text, paint)).toInt().coerceAtLeast(1)
      val layout =
        StaticLayout.Builder
          .obtain(text, 0, text.length, paint, contentWidth)
          .setIncludePad(false)
          .setLineSpacing(0f, 1f)
          .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
          .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
          .build()
      return layout.height.toFloat() + inset * 2 + headerH
    }
  }
}
