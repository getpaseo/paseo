package com.swmansion.enriched.markdown

import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.Layout
import android.util.AttributeSet
import android.util.Log
import android.util.TypedValue
import android.view.MotionEvent
import android.view.View
import android.view.View.MeasureSpec
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.uimanager.BackgroundStyleApplicator
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.StateWrapper
import com.facebook.react.uimanager.style.LogicalEdge
import com.swmansion.enriched.markdown.accessibility.AccessibilityLabels
import com.swmansion.enriched.markdown.accessibility.AccessibleMarkdownTextView
import com.swmansion.enriched.markdown.math.LatexErrorReporter
import com.swmansion.enriched.markdown.parser.Md4cFlags
import com.swmansion.enriched.markdown.parser.Parser
import com.swmansion.enriched.markdown.renderer.Renderer
import com.swmansion.enriched.markdown.spoiler.SpoilerCapable
import com.swmansion.enriched.markdown.spoiler.SpoilerOverlay
import com.swmansion.enriched.markdown.spoiler.SpoilerOverlayDrawer
import com.swmansion.enriched.markdown.styles.LinkPillContent
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.utils.common.BreakStrategyUtils
import com.swmansion.enriched.markdown.utils.common.EllipsizeUtils
import com.swmansion.enriched.markdown.utils.common.LinkRegexConfig
import com.swmansion.enriched.markdown.utils.common.emitCodeBlockPress
import com.swmansion.enriched.markdown.utils.text.TailFadeInAnimator
import com.swmansion.enriched.markdown.utils.text.interaction.CheckboxTouchHelper
import com.swmansion.enriched.markdown.utils.text.view.CodeBlockPressHost
import com.swmansion.enriched.markdown.utils.text.view.ImagePressHost
import com.swmansion.enriched.markdown.utils.text.view.LinkLongPressMovementMethod
import com.swmansion.enriched.markdown.utils.text.view.SelectionMenuConfig
import com.swmansion.enriched.markdown.utils.text.view.applySelectableState
import com.swmansion.enriched.markdown.utils.text.view.applySelectionColors
import com.swmansion.enriched.markdown.utils.text.view.cancelJSTouchForCheckboxTap
import com.swmansion.enriched.markdown.utils.text.view.cancelJSTouchForLinkTap
import com.swmansion.enriched.markdown.utils.text.view.createSelectionActionModeCallback
import com.swmansion.enriched.markdown.utils.text.view.emitImagePressEvent
import com.swmansion.enriched.markdown.utils.text.view.emitLinkLongPressEvent
import com.swmansion.enriched.markdown.utils.text.view.emitLinkPressEvent
import com.swmansion.enriched.markdown.utils.text.view.reallowParentInterceptIfLinkReleased
import com.swmansion.enriched.markdown.utils.text.view.setupAsMarkdownTextView
import java.util.concurrent.Executors
import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * EnrichedMarkdownText that handles Markdown parsing and rendering on a background thread.
 * View starts invisible and becomes visible after render completes to avoid layout shift.
 */
class EnrichedMarkdownText
  @JvmOverloads
  constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
  ) : AccessibleMarkdownTextView(context, attrs, defStyleAttr),
    SpoilerCapable,
    ImagePressHost,
    CodeBlockPressHost {
    private val parser = Parser.shared
    private val renderer = Renderer()
    private var onLinkPressCallback: ((String, String) -> Unit)? = null
    private var onLinkLongPressCallback: ((String) -> Unit)? = null
    private var onLatexErrorCallback: LatexErrorReporter? = null

    private val reportedLatexErrors = HashSet<String>()

    private val latexErrorReporter =
      LatexErrorReporter { source, message, displayMode ->
        val key = (if (displayMode) "B " else "I ") + source
        if (reportedLatexErrors.add(key)) {
          onLatexErrorCallback?.report(source, message, displayMode)
        }
      }
    private val checkboxTouchHelper = CheckboxTouchHelper(this)

    private val mainHandler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private var currentRenderId = 0L

    val layoutManager = EnrichedMarkdownTextLayoutManager(this)

    // used to force a Yoga re-measure when a block image resolves its box height
    var stateWrapper: StateWrapper? = null

    private var contextMenuItemTexts: List<String> = emptyList()
    var onContextMenuItemPressCallback: ((itemText: String, selectedText: String, selectionStart: Int, selectionEnd: Int) -> Unit)? = null

    var markdownStyle: StyleConfig? = null
      private set

    var currentMarkdown: String = ""
      private set

    var md4cFlags: Md4cFlags = Md4cFlags.DEFAULT
      private set
    private var linkRegex: LinkRegexConfig? = null
    private var inlineCodeLinkRegex: LinkRegexConfig? = null
    private var isGFM: Boolean = false

    private var lastKnownFontScale: Float = context.resources.configuration.fontScale
    private var markdownStyleMap: ReadableMap? = null

    private var allowFontScaling: Boolean = true
    private var maxFontSizeMultiplier: Float = 0f
    private var allowTrailingMargin: Boolean = false
    private var imageRequestHeaders: Map<String, String> = emptyMap()
    private var linkPillContent: Map<String, LinkPillContent> = emptyMap()

    private var streamingAnimation: Boolean = false
    private var previousTextLength: Int = 0
    private var fadeAnimator: TailFadeInAnimator? = null
    override var spoilerOverlayDrawer: SpoilerOverlayDrawer? = null
      private set
    var spoilerOverlay: SpoilerOverlay = SpoilerOverlay.PARTICLES

    private var pendingStyledText: CharSequence? = null

    private var mdNumberOfLines: Int = 0
    private var mdEllipsizeMode: String = EllipsizeUtils.DEFAULT_MODE
    private var mdSelectable: Boolean = true

    private var selectionColor: Int? = null
    private var selectionHandleColor: Int? = null
    private var selectionMenuConfig = SelectionMenuConfig()
    private var baseHorizontalPaddingLeft = 0
    private var baseHorizontalPaddingRight = 0
    private var applyingContentBoxInset = false

    init {
      setupAsMarkdownTextView()
      customSelectionActionModeCallback =
        createSelectionActionModeCallback(
          this,
          getCustomItemTexts = { contextMenuItemTexts },
          getSelectionMenuConfig = { selectionMenuConfig },
          onCustomItemPress = { itemText, selectedText, start, end ->
            onContextMenuItemPressCallback?.invoke(itemText, selectedText, start, end)
          },
        )
    }

    fun setMarkdownContent(markdown: String) {
      if (currentMarkdown == markdown) return
      currentMarkdown = markdown
      scheduleRender()
    }

    fun setMarkdownStyle(style: ReadableMap?) {
      markdownStyleMap = style
      // Register font scaling settings when style is set (view should have ID by now)
      updateMeasurementStoreFontScaling()
      val newStyle = style?.let { StyleConfig(it, context, allowFontScaling, maxFontSizeMultiplier) }
      newStyle?.imageRequestHeaders = imageRequestHeaders
      newStyle?.linkPillContent = linkPillContent
      if (markdownStyle == newStyle) return
      markdownStyle = newStyle
      updateJustificationMode(newStyle)
      scheduleRender()
    }

    fun setImageRequestHeaders(headers: Map<String, String>) {
      if (imageRequestHeaders == headers) return
      imageRequestHeaders = headers
      markdownStyle?.imageRequestHeaders = headers
      scheduleRenderIfNeeded()
    }

    fun setLinkPillContent(content: Map<String, LinkPillContent>) {
      if (linkPillContent == content) return
      linkPillContent = content
      markdownStyle?.linkPillContent = content
      scheduleRenderIfNeeded()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
      super.onConfigurationChanged(newConfig)

      if (!allowFontScaling) {
        return
      }

      val newFontScale = newConfig.fontScale
      if (newFontScale != lastKnownFontScale) {
        lastKnownFontScale = newFontScale
        recreateStyleConfig()
        scheduleRenderIfNeeded()
      }
    }

    fun setLinkRegex(config: LinkRegexConfig?) {
      if (linkRegex == config) return
      linkRegex = config
      scheduleRenderIfNeeded()
    }

    fun setInlineCodeLinkRegex(config: LinkRegexConfig?) {
      if (inlineCodeLinkRegex == config) return
      inlineCodeLinkRegex = config
      scheduleRenderIfNeeded()
    }

    fun setMd4cFlags(flags: Md4cFlags) {
      if (md4cFlags == flags) return
      md4cFlags = flags
      scheduleRenderIfNeeded()
    }

    fun setIsGFM(value: Boolean) {
      if (isGFM == value) return
      isGFM = value
      scheduleRenderIfNeeded()
    }

    fun setAllowFontScaling(allow: Boolean) {
      if (allowFontScaling == allow) return
      allowFontScaling = allow
      updateMeasurementStoreFontScaling()
      recreateStyleConfig()
      scheduleRenderIfNeeded()
    }

    fun setMaxFontSizeMultiplier(multiplier: Float) {
      if (maxFontSizeMultiplier == multiplier) return
      maxFontSizeMultiplier = multiplier
      updateMeasurementStoreFontScaling()
      recreateStyleConfig()
      scheduleRenderIfNeeded()
    }

    fun setAllowTrailingMargin(allow: Boolean) {
      if (allowTrailingMargin == allow) return
      allowTrailingMargin = allow
      scheduleRenderIfNeeded()
    }

    fun setStreamingAnimation(enabled: Boolean) {
      if (streamingAnimation == enabled) return
      streamingAnimation = enabled
      if (enabled) {
        previousTextLength = text?.length ?: 0
      } else {
        fadeAnimator?.cancelAll()
        fadeAnimator = null
        previousTextLength = 0
      }
    }

    fun commitProps() {
      updateMeasurementStoreFontScaling()
    }

    private fun updateMeasurementStoreFontScaling() {
      MeasurementStore.updateFontScalingSettings(id, allowFontScaling, maxFontSizeMultiplier)
    }

    private fun scheduleRenderIfNeeded() {
      if (currentMarkdown.isNotEmpty()) {
        scheduleRender()
      }
    }

    private fun recreateStyleConfig() {
      markdownStyleMap?.let { styleMap ->
        markdownStyle =
          StyleConfig(styleMap, context, allowFontScaling, maxFontSizeMultiplier).also {
            it.imageRequestHeaders = imageRequestHeaders
            it.linkPillContent = linkPillContent
          }
        updateJustificationMode(markdownStyle)
      }
    }

    private fun updateJustificationMode(style: StyleConfig?) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        justificationMode =
          if (style?.needsJustify == true) {
            Layout.JUSTIFICATION_MODE_INTER_WORD
          } else {
            Layout.JUSTIFICATION_MODE_NONE
          }
      }
    }

    private fun scheduleRender() {
      val style = markdownStyle ?: return
      val markdown = currentMarkdown
      if (markdown.isEmpty()) return

      val textLinkRegex = linkRegex
      val codeLinkRegex = inlineCodeLinkRegex
      val renderId = ++currentRenderId

      executor.execute {
        try {
          val ast =
            parser.parseMarkdown(markdown, md4cFlags, isGFM, textLinkRegex, codeLinkRegex) ?: run {
              mainHandler.post { if (renderId == currentRenderId && isAttachedToWindow) text = "" }
              return@execute
            }

          renderer.configure(style, context, latexErrorReporter)
          val styledText = renderer.renderDocument(ast, onLinkPressCallback, onLinkLongPressCallback)

          mainHandler.post {
            if (renderId == currentRenderId) {
              if (isAttachedToWindow) {
                applyRenderedText(styledText)
              } else {
                pendingStyledText = styledText
              }
            }
          }
        } catch (e: Exception) {
          Log.e(TAG, "Render failed: ${e.message}", e)
          mainHandler.post { if (renderId == currentRenderId && isAttachedToWindow) text = "" }
        }
      }
    }

    private fun applyRenderedText(styledText: CharSequence) {
      val tailStart = previousTextLength

      markdownStyle?.paragraphStyle?.fontSize?.let {
        setTextSize(TypedValue.COMPLEX_UNIT_PX, it)
      }

      text = styledText

      applyInteractivity()

      renderer.getCollectedImageSpans().forEach { span ->
        span.registerTextView(this)
      }

      spoilerOverlayDrawer = SpoilerOverlayDrawer.setupIfNeeded(this, styledText, spoilerOverlayDrawer, spoilerOverlay)

      layoutManager.invalidateLayout()
      accessibilityHelper.invalidateAccessibilityItems()

      if (streamingAnimation) {
        if (fadeAnimator == null) {
          fadeAnimator = TailFadeInAnimator(this)
        }
        fadeAnimator?.animate(tailStart, styledText.length)
        previousTextLength = styledText.length
      }

      applySelectionColors(selectionColor, selectionHandleColor)
    }

    // Trailing bottom margin included in the shadow-node measurement — must be
    // mirrored when re-storing the measurement from the display text.
    fun trailingMarginBottomPx(): Float = if (allowTrailingMargin) renderer.getLastElementMarginBottom() else 0f

    fun setContextMenuItems(items: List<String>) {
      contextMenuItemTexts = items
    }

    fun setSelectionMenuConfig(config: SelectionMenuConfig) {
      if (selectionMenuConfig == config) return
      selectionMenuConfig = config
    }

    fun setAccessibilityLabels(labels: AccessibilityLabels) {
      accessibilityHelper.labels = labels
    }

    fun setIsSelectable(selectable: Boolean) {
      mdSelectable = selectable
      applyInteractivity()
    }

    fun setSelectionColor(color: Int?) {
      if (selectionColor == color) return
      selectionColor = color
      applySelectionColors(selectionColor, selectionHandleColor)
    }

    fun setSelectionHandleColor(color: Int?) {
      if (selectionHandleColor == color) return
      selectionHandleColor = color
      applySelectionColors(selectionColor, selectionHandleColor)
    }

    fun setTextBreakStrategy(strategy: String) {
      MeasurementStore.updateBreakStrategy(id, strategy)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        breakStrategy = BreakStrategyUtils.resolveBreakStrategy(strategy)
      }
      MeasurementStore.invalidate(id)
      scheduleRenderIfNeeded()
    }

    fun setMarkdownNumberOfLines(value: Int) {
      val normalized = value.coerceAtLeast(0)
      if (mdNumberOfLines == normalized) return
      mdNumberOfLines = normalized
      MeasurementStore.updateNumberOfLines(id, normalized)
      applyLineLimitToView()
      MeasurementStore.invalidate(id)
      scheduleRenderIfNeeded()
    }

    fun setMarkdownEllipsizeMode(value: String) {
      if (mdEllipsizeMode == value) return
      mdEllipsizeMode = value
      MeasurementStore.updateEllipsizeMode(id, value)
      applyLineLimitToView()
      MeasurementStore.invalidate(id)
      scheduleRenderIfNeeded()
    }

    // Mirrors RN's ReactTextView.updateView: only ellipsize when a line limit is
    // set; unlimited restores the default unbounded, non-ellipsized state.
    private fun applyLineLimitToView() {
      if (mdNumberOfLines > 0) {
        maxLines = mdNumberOfLines
        ellipsize = EllipsizeUtils.resolveTruncateAt(mdEllipsizeMode)
      } else {
        maxLines = Integer.MAX_VALUE
        ellipsize = null
      }
      applyInteractivity()
    }

    // The numberOfLines ellipsis and text selection / link taps are mutually
    // exclusive on Android and cannot be reconciled. Both setTextIsSelectable(true)
    // and a non-null movementMethod force the display text to a Spannable, which
    // makes TextView pick DynamicLayout (TextView.useDynamicLayout). DynamicLayout
    // has no setMaxLines, so the clamp is never baked into the layout and no
    // ellipsis glyph is drawn (verified against AOSP TextView/DynamicLayout on
    // API 35/36). To keep the ellipsis, a clamped view must be non-selectable AND
    // drop its movement method; both are restored to the user's preference once
    // the clamp is removed.
    private fun applyInteractivity() {
      if (mdNumberOfLines > 0) {
        if (isTextSelectable) setTextIsSelectable(false)
        movementMethod = null
      } else {
        applySelectableState(mdSelectable)
        if (movementMethod !is LinkLongPressMovementMethod) {
          movementMethod = LinkLongPressMovementMethod.createInstance()
        }
      }
    }

    fun emitOnLinkPress(url: String, sourceType: String) {
      emitLinkPressEvent(url, sourceType)
    }

    fun emitOnLinkLongPress(url: String) {
      emitLinkLongPressEvent(url)
    }

    override var imagePressEnabled: Boolean = false
      private set

    override fun emitOnImagePress(
      url: String,
      altText: String,
    ) {
      emitImagePressEvent(url, altText)
    }

    fun setEnableImagePress(enabled: Boolean) {
      imagePressEnabled = enabled
    }

    override var codeBlockPressEnabled: Boolean = false
      private set

    override fun emitOnCodeBlockPress(
      code: String,
      language: String,
    ) {
      emitCodeBlockPress(this, code, language)
    }

    fun setEnableCodeBlockPress(enabled: Boolean) {
      codeBlockPressEnabled = enabled
    }

    fun setOnLinkPressCallback(callback: (String, String) -> Unit) {
      onLinkPressCallback = callback
    }

    fun setOnLinkLongPressCallback(callback: (String) -> Unit) {
      onLinkLongPressCallback = callback
    }

    fun setOnLatexErrorCallback(callback: LatexErrorReporter) {
      onLatexErrorCallback = callback
    }

    fun setOnTaskListItemPressCallback(callback: ((taskIndex: Int, checked: Boolean, itemText: String) -> Unit)?) {
      checkboxTouchHelper.onCheckboxTap = callback
    }

    fun setEnableTaskListItemToggle(enabled: Boolean) {
      checkboxTouchHelper.isEnabled = enabled
    }

    fun cleanup() {
      currentRenderId++
      executor.shutdownNow()
      mainHandler.removeCallbacksAndMessages(null)
      pendingStyledText = null
      fadeAnimator?.cancelAll()
      fadeAnimator = null
    }

    override fun setPadding(
      left: Int,
      top: Int,
      right: Int,
      bottom: Int,
    ) {
      if (!applyingContentBoxInset) {
        baseHorizontalPaddingLeft = left
        baseHorizontalPaddingRight = right
      }
      super.setPadding(left, top, right, bottom)
    }

    override fun onMeasure(
      widthMeasureSpec: Int,
      heightMeasureSpec: Int,
    ) {
      applyContentBoxInset(widthMeasureSpec)
      super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    /**
     * Fabric measures text at the content box (frame - padding - border) but the TextView's
     * padding carries no border, so it wraps ~1dp wider and reserves a phantom trailing line
     * under an unclamped box (#805). Fold the border into padding to match; restore the base
     * padding when the cache or an exact frame is missing so no stale inset lingers.
     */
    private fun applyContentBoxInset(widthMeasureSpec: Int) {
      val contentBox =
        if (MeasureSpec.getMode(widthMeasureSpec) == MeasureSpec.EXACTLY) {
          MeasurementStore.contentBoxWidthPx(id)?.let { ceil(it).toInt() }?.takeIf { it > 0 }
        } else {
          null
        }
      val frame = MeasureSpec.getSize(widthMeasureSpec)
      if (contentBox == null || frame <= 0) {
        setHorizontalPadding(baseHorizontalPaddingLeft, baseHorizontalPaddingRight)
        return
      }

      val totalInset = (frame - contentBox).coerceIn(0, frame)
      val left = (baseHorizontalPaddingLeft + resolvedBorderPx(leftEdge = true)).coerceIn(0, totalInset)
      val right = (totalInset - left).coerceAtLeast(0)
      setHorizontalPadding(left, right)
    }

    // Physical border width (px); only the left/right split reads it, never the total inset.
    private fun resolvedBorderPx(leftEdge: Boolean): Int {
      val rtl = layoutDirection == View.LAYOUT_DIRECTION_RTL
      val physical = if (leftEdge) LogicalEdge.LEFT else LogicalEdge.RIGHT
      val logical = if (leftEdge != rtl) LogicalEdge.START else LogicalEdge.END
      val dp =
        BackgroundStyleApplicator.getBorderWidth(this, physical)
          ?: BackgroundStyleApplicator.getBorderWidth(this, logical)
          ?: BackgroundStyleApplicator.getBorderWidth(this, LogicalEdge.ALL)
          ?: return 0
      return PixelUtil.toPixelFromDIP(dp).roundToInt().coerceAtLeast(0)
    }

    private fun setHorizontalPadding(
      left: Int,
      right: Int,
    ) {
      if (left == paddingLeft && right == paddingRight) return
      applyingContentBoxInset = true
      super.setPadding(left, paddingTop, right, paddingBottom)
      applyingContentBoxInset = false
    }

    override fun onAttachedToWindow() {
      super.onAttachedToWindow()
      pendingStyledText?.let {
        pendingStyledText = null
        applyRenderedText(it)
      }
    }

    override fun onDetachedFromWindow() {
      stopSpoilerAnimations()
      super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      spoilerOverlayDrawer?.draw(canvas)
    }

    private fun stopSpoilerAnimations() {
      spoilerOverlayDrawer?.stop()
      spoilerOverlayDrawer = null
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
      if (checkboxTouchHelper.onTouchEvent(event)) {
        if (event.action == MotionEvent.ACTION_DOWN) {
          cancelJSTouchForCheckboxTap(event)
        }
        return true
      }
      val result = super.onTouchEvent(event)
      when (event.action) {
        MotionEvent.ACTION_DOWN -> cancelJSTouchForLinkTap(event)
        else -> reallowParentInterceptIfLinkReleased()
      }
      return result
    }

    companion object {
      private const val TAG = "EnrichedMarkdownMeasure"
    }
  }
