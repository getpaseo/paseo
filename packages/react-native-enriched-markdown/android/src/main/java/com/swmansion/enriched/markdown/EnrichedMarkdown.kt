package com.swmansion.enriched.markdown

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.uimanager.StateWrapper
import com.swmansion.enriched.markdown.accessibility.AccessibilityLabels
import com.swmansion.enriched.markdown.math.LatexErrorReporter
import com.swmansion.enriched.markdown.parser.Md4cFlags
import com.swmansion.enriched.markdown.parser.Parser
import com.swmansion.enriched.markdown.segments.BlockquoteContainerView
import com.swmansion.enriched.markdown.segments.CodeBlockContainerView
import com.swmansion.enriched.markdown.segments.ContainerNodeView
import com.swmansion.enriched.markdown.segments.DynamicBlockProps
import com.swmansion.enriched.markdown.segments.MarkdownSegmentRenderer
import com.swmansion.enriched.markdown.segments.RenderedSegment
import com.swmansion.enriched.markdown.segments.SegmentViewConfig
import com.swmansion.enriched.markdown.segments.SegmentViewCreators
import com.swmansion.enriched.markdown.segments.SegmentViewFactory
import com.swmansion.enriched.markdown.segments.TableContainerView
import com.swmansion.enriched.markdown.segments.splitASTIntoSegments
import com.swmansion.enriched.markdown.spoiler.SpoilerOverlay
import com.swmansion.enriched.markdown.styles.LinkPillContent
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.utils.common.BreakStrategyUtils
import com.swmansion.enriched.markdown.utils.common.CodeBlockStreamingMode
import com.swmansion.enriched.markdown.utils.common.LinkRegexConfig
import com.swmansion.enriched.markdown.utils.common.StreamingMarkdownFilter
import com.swmansion.enriched.markdown.utils.common.TableStreamingMode
import com.swmansion.enriched.markdown.utils.common.isReducedMotionEnabled
import com.swmansion.enriched.markdown.utils.text.TailFadeInAnimator
import com.swmansion.enriched.markdown.utils.text.view.ImagePressHost
import com.swmansion.enriched.markdown.utils.text.view.SelectionMenuConfig
import com.swmansion.enriched.markdown.utils.text.view.applySelectionColors
import com.swmansion.enriched.markdown.utils.text.view.emitImagePressEvent
import java.util.EnumSet
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class EnrichedMarkdown(
  context: Context,
) : ContainerNodeView(context),
  ImagePressHost {
  private enum class DirtyFlag {
    RECREATE_SEGMENTS,
    FORCE_HEIGHT,
  }

  private val parser = Parser.shared
  private val mainHandler = Handler(Looper.getMainLooper())
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()
  private val mathContainerClass: Class<*>? by lazy { SegmentViewCreators.mathContainerClass() }
  private val videoContainerClass: Class<*>? by lazy { SegmentViewCreators.videoContainerClass() }

  private var currentRenderId = 0L
  private val dirtyFlags = EnumSet.noneOf(DirtyFlag::class.java)
  var streamingAnimation: Boolean = false

  // used to force a Yoga re-measure when a block image resolves its box height
  var stateWrapper: StateWrapper? = null
  private var forceHeightRecalculationCounter = 0

  var tableStreamingMode: TableStreamingMode = TableStreamingMode.PROGRESSIVE
  var codeBlockStreamingMode: CodeBlockStreamingMode = CodeBlockStreamingMode.PROGRESSIVE
  private var renderPending: Boolean = false

  var currentMarkdown: String = ""
    private set

  var markdownStyle: StyleConfig? = null
    private set

  private var markdownStyleMap: ReadableMap? = null
  private var lastKnownFontScale: Float = context.resources.configuration.fontScale

  var md4cFlags: Md4cFlags = Md4cFlags.DEFAULT
    private set
  private var linkRegex: LinkRegexConfig? = null
  private var inlineCodeLinkRegex: LinkRegexConfig? = null
  private var isGFM: Boolean = true
  private var allowFontScaling: Boolean = true
  private var maxFontSizeMultiplier: Float = 0f
  private var imageRequestHeaders: Map<String, String> = emptyMap()
  private var linkPillContent: Map<String, LinkPillContent> = emptyMap()
  private var selectable: Boolean = true
  private var selectionColor: Int? = null
  private var selectionHandleColor: Int? = null
  private var selectionMenuConfig = SelectionMenuConfig()
  private var accessibilityLabels = AccessibilityLabels()
  private var textBreakStrategy: String = BreakStrategyUtils.DEFAULT_STRATEGY

  private var onLinkPressCallback: ((String, String) -> Unit)? = null
  private var onLinkLongPressCallback: ((String) -> Unit)? = null
  private var onTaskListItemPressCallback: ((Int, Boolean, String) -> Unit)? = null
  private var onLatexErrorCallback: LatexErrorReporter? = null

  private val reportedLatexErrors = HashSet<String>()

  private val latexErrorReporter =
    LatexErrorReporter { source, message, displayMode ->
      val key = (if (displayMode) "B " else "I ") + source
      if (reportedLatexErrors.add(key)) {
        onLatexErrorCallback?.report(source, message, displayMode)
      }
    }
  private var contextMenuItemTexts: List<String> = emptyList()
  var onContextMenuItemPressCallback: ((itemText: String, selectedText: String, selectionStart: Int, selectionEnd: Int) -> Unit)? = null
  var spoilerOverlay: SpoilerOverlay = SpoilerOverlay.PARTICLES
    set(value) {
      if (field == value) return
      field = value
      segmentViews.filterIsInstance<EnrichedMarkdownInternalText>().forEach {
        it.spoilerOverlay = value
      }
    }
  var enableTaskListItemToggle: Boolean = true
    set(value) {
      if (field == value) return
      field = value
      segmentViews.filterIsInstance<EnrichedMarkdownInternalText>().forEach {
        it.enableTaskListItemToggle = value
      }
    }

  private val dynamicProps = DynamicBlockProps()

  var enableBlockContextMenu: Boolean
    get() = dynamicProps.enableBlockContextMenu
    set(value) {
      dynamicProps.enableBlockContextMenu = value
    }
  var enableCodeBlockPress: Boolean
    get() = dynamicProps.enableCodeBlockPress
    set(value) {
      dynamicProps.enableCodeBlockPress = value
    }

  init {
    segmentViewFactory = RootFactory()
  }

  fun setMarkdownContent(markdown: String) {
    if (currentMarkdown == markdown) return
    currentMarkdown = markdown
    renderPending = true
  }

  fun setMarkdownStyle(style: ReadableMap?) {
    markdownStyleMap = style
    val newConfig = style?.let { StyleConfig(it, context, allowFontScaling, maxFontSizeMultiplier) }
    newConfig?.imageRequestHeaders = imageRequestHeaders
    newConfig?.linkPillContent = linkPillContent
    if (markdownStyle == newConfig) return
    markdownStyle = newConfig
    dirtyFlags += DirtyFlag.RECREATE_SEGMENTS
    dirtyFlags += DirtyFlag.FORCE_HEIGHT
    renderPending = true
  }

  fun setImageRequestHeaders(headers: Map<String, String>) {
    if (imageRequestHeaders == headers) return
    imageRequestHeaders = headers
    markdownStyle?.imageRequestHeaders = headers
    dirtyFlags += DirtyFlag.RECREATE_SEGMENTS
    renderPending = true
  }

  fun setLinkPillContent(content: Map<String, LinkPillContent>) {
    if (linkPillContent == content) return
    linkPillContent = content
    markdownStyle?.linkPillContent = content
    // A label can change the pill's width and so the wrapped height.
    dirtyFlags += DirtyFlag.RECREATE_SEGMENTS
    dirtyFlags += DirtyFlag.FORCE_HEIGHT
    renderPending = true
  }

  fun commitProps() {
    MeasurementStore.updateStreamingTableMode(id, tableStreamingMode)
    MeasurementStore.updateStreamingCodeBlockMode(id, codeBlockStreamingMode)
    MeasurementStore.updateFontScalingSettings(id, allowFontScaling, maxFontSizeMultiplier)
    if (renderPending) {
      renderPending = false
      scheduleRenderIfNeeded()
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    if (!allowFontScaling) return
    val newFontScale = newConfig.fontScale
    if (newFontScale != lastKnownFontScale) {
      lastKnownFontScale = newFontScale
      recreateStyleConfig()
      dirtyFlags += DirtyFlag.RECREATE_SEGMENTS
      dirtyFlags += DirtyFlag.FORCE_HEIGHT
      scheduleRenderIfNeeded()
    }
  }

  fun setLinkRegex(config: LinkRegexConfig?) {
    if (linkRegex == config) return
    linkRegex = config
    renderPending = true
  }

  fun setInlineCodeLinkRegex(config: LinkRegexConfig?) {
    if (inlineCodeLinkRegex == config) return
    inlineCodeLinkRegex = config
    renderPending = true
  }

  fun setMd4cFlags(flags: Md4cFlags) {
    if (md4cFlags == flags) return
    md4cFlags = flags
    renderPending = true
  }

  fun setIsGFM(value: Boolean) {
    if (isGFM == value) return
    isGFM = value
    renderPending = true
  }

  fun setAllowFontScaling(allow: Boolean) {
    if (allowFontScaling == allow) return
    allowFontScaling = allow
    MeasurementStore.updateFontScalingSettings(id, allowFontScaling, maxFontSizeMultiplier)
    recreateStyleConfig()
    dirtyFlags += DirtyFlag.RECREATE_SEGMENTS
    dirtyFlags += DirtyFlag.FORCE_HEIGHT
    renderPending = true
  }

  fun setMaxFontSizeMultiplier(multiplier: Float) {
    if (maxFontSizeMultiplier == multiplier) return
    maxFontSizeMultiplier = multiplier
    MeasurementStore.updateFontScalingSettings(id, allowFontScaling, maxFontSizeMultiplier)
    recreateStyleConfig()
    dirtyFlags += DirtyFlag.RECREATE_SEGMENTS
    dirtyFlags += DirtyFlag.FORCE_HEIGHT
    renderPending = true
  }

  fun setAllowTrailingMargin(allow: Boolean) {
    if (trailingMarginEnabled == allow) return
    trailingMarginEnabled = allow
    dirtyFlags += DirtyFlag.RECREATE_SEGMENTS
    dirtyFlags += DirtyFlag.FORCE_HEIGHT
    renderPending = true
  }

  fun setIsSelectable(value: Boolean) {
    if (selectable == value) return
    selectable = value
    segmentViews.filterIsInstance<EnrichedMarkdownInternalText>().forEach {
      it.setIsSelectable(value)
    }
  }

  fun setSelectionColor(color: Int?) {
    if (selectionColor == color) return
    selectionColor = color
    applySelectionColorsToSegments()
  }

  fun setSelectionHandleColor(color: Int?) {
    if (selectionHandleColor == color) return
    selectionHandleColor = color
    applySelectionColorsToSegments()
  }

  fun setTextBreakStrategy(strategy: String) {
    if (textBreakStrategy == strategy) return
    textBreakStrategy = strategy
    MeasurementStore.updateBreakStrategy(id, strategy)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      val resolved = BreakStrategyUtils.resolveBreakStrategy(strategy)
      segmentViews.filterIsInstance<EnrichedMarkdownInternalText>().forEach {
        it.breakStrategy = resolved
      }
    }
    dirtyFlags += DirtyFlag.FORCE_HEIGHT
    renderPending = true
  }

  private fun applySelectionColorsToSegments() {
    segmentViews.filterIsInstance<EnrichedMarkdownInternalText>().forEach {
      it.applySelectionColors(selectionColor, selectionHandleColor)
    }
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

  fun setOnTaskListItemPressCallback(callback: ((taskIndex: Int, checked: Boolean, itemText: String) -> Unit)?) {
    onTaskListItemPressCallback = callback
  }

  fun setOnCopyPressCallback(callback: ((code: String, language: String) -> Unit)?) {
    dynamicProps.onCopyPress = callback
  }

  fun setOnCodeBlockPressCallback(callback: ((code: String, language: String) -> Unit)?) {
    dynamicProps.onCodeBlockPress = callback
  }

  fun setContextMenuItems(items: List<String>) {
    contextMenuItemTexts = items
    segmentViews.filterIsInstance<EnrichedMarkdownInternalText>().forEach {
      it.setContextMenuItems(items, ::forwardContextMenuItemPress)
    }
  }

  fun setSelectionMenuConfig(config: SelectionMenuConfig) {
    if (selectionMenuConfig == config) return
    selectionMenuConfig = config
    dynamicProps.copyLabel = config.copyLabel
    dynamicProps.copyAsMarkdownLabel = config.copyAsMarkdownLabel
    segmentViews.filterIsInstance<EnrichedMarkdownInternalText>().forEach {
      it.selectionMenuConfig = config
    }
  }

  fun setAccessibilityLabels(labels: AccessibilityLabels) {
    if (accessibilityLabels == labels) return
    accessibilityLabels = labels
    segmentViews.filterIsInstance<EnrichedMarkdownInternalText>().forEach {
      it.accessibilityLabels = labels
    }
    segmentViews.filterIsInstance<TableContainerView>().forEach {
      it.accessibilityLabels = labels
    }
    mathContainerClass?.let { mathClass ->
      segmentViews.filter { mathClass.isInstance(it) }.forEach { view ->
        runCatching {
          mathClass
            .getMethod("setAccessibilityLabels", AccessibilityLabels::class.java)
            .invoke(view, labels)
        }
      }
    }
  }

  private fun forwardContextMenuItemPress(
    itemText: String,
    selectedText: String,
    selectionStart: Int,
    selectionEnd: Int,
  ) {
    onContextMenuItemPressCallback?.invoke(itemText, selectedText, selectionStart, selectionEnd)
  }

  private fun recreateStyleConfig() {
    markdownStyleMap?.let {
      markdownStyle =
        StyleConfig(it, context, allowFontScaling, maxFontSizeMultiplier).also { config ->
          config.imageRequestHeaders = imageRequestHeaders
          config.linkPillContent = linkPillContent
        }
    }
  }

  private fun scheduleRenderIfNeeded() {
    if (currentMarkdown.isNotEmpty()) scheduleRender()
  }

  private fun scheduleRender() {
    val style = markdownStyle ?: return
    val markdown = currentMarkdown.takeIf { it.isNotEmpty() } ?: return
    val isStreaming = streamingAnimation
    val tableMode = tableStreamingMode
    val codeBlockMode = codeBlockStreamingMode

    val textLinkRegex = linkRegex
    val codeLinkRegex = inlineCodeLinkRegex
    val renderId = ++currentRenderId

    dispatchMarkdownRender(segmentViews.isNotEmpty(), executor) {
      try {
        val filtered =
          if (isStreaming) {
            StreamingMarkdownFilter.renderableMarkdownForStreaming(markdown, tableMode, codeBlockMode)
          } else {
            null
          }
        val renderableMarkdown = filtered?.markdown ?: markdown
        val hasPendingCodeBlock = filtered?.endsInsideOpenCodeFence ?: false

        if (renderableMarkdown.isEmpty()) {
          postToMain(renderId) { applyRenderedSegments(emptyList(), false) }
          return@dispatchMarkdownRender
        }

        val ast =
          parser.parseMarkdown(renderableMarkdown, md4cFlags, isGFM, textLinkRegex, codeLinkRegex) ?: run {
            postToMain(renderId) { applyRenderedSegments(emptyList(), false) }
            return@dispatchMarkdownRender
          }

        val segments = splitASTIntoSegments(ast)
        val renderedSegments =
          MarkdownSegmentRenderer.render(
            segments,
            style,
            context,
            onLinkPressCallback,
            onLinkLongPressCallback,
            onLatexError = latexErrorReporter,
          )

        postToMain(renderId) { applyRenderedSegments(renderedSegments, hasPendingCodeBlock) }
      } catch (e: Exception) {
        Log.e(TAG, "Render failed", e)
        postToMain(renderId) { applyRenderedSegments(emptyList(), false) }
      }
    }
  }

  // Trailing code block whose closing fence hasn't streamed in yet, if any.
  private var pendingCodeBlockSegment: RenderedSegment.CodeBlock? = null

  private fun applyRenderedSegments(
    renderedSegments: List<RenderedSegment>,
    hasPendingCodeBlock: Boolean,
  ) {
    pendingCodeBlockSegment =
      if (hasPendingCodeBlock) renderedSegments.lastOrNull() as? RenderedSegment.CodeBlock else null

    val reset = DirtyFlag.RECREATE_SEGMENTS in dirtyFlags
    val forceHeight = DirtyFlag.FORCE_HEIGHT in dirtyFlags
    dirtyFlags.clear()

    val topologyChanged = applySegments(renderedSegments, reset)

    // A just-closed block has unchanged content, so the reconciler reuses it
    // without an update; sync pending here to trigger its deferred highlight.
    segmentViews.forEachIndexed { index, view ->
      if (view is CodeBlockContainerView) {
        view.pending = pendingCodeBlockSegment != null && index == segmentViews.size - 1
      }
    }

    if (width > 0) {
      val heightBefore = computeSegmentsTotalHeight()
      layoutSegments()
      val heightAfter = computeSegmentsTotalHeight()

      if (forceHeight || topologyChanged || heightBefore != heightAfter) {
        MeasurementStore.invalidate(id)
        requestLayout()
        stateWrapper?.let {
          val state = Arguments.createMap()
          state.putInt("forceHeightRecalculationCounter", ++forceHeightRecalculationCounter)
          it.updateState(state)
        }
      }
    }
  }

  private fun isMathContainerView(view: View): Boolean = mathContainerClass?.isInstance(view) == true

  private fun isVideoContainerView(view: View): Boolean = videoContainerClass?.isInstance(view) == true

  private fun segmentViewConfig(): SegmentViewConfig =
    SegmentViewConfig(
      context = context,
      style = markdownStyle!!,
      allowFontScaling = allowFontScaling,
      maxFontSizeMultiplier = maxFontSizeMultiplier,
      accessibilityLabels = accessibilityLabels,
      selectionMenuConfig = selectionMenuConfig,
      textBreakStrategy = textBreakStrategy,
      selectable = selectable,
      selectionColor = selectionColor,
      selectionHandleColor = selectionHandleColor,
      contextMenuItemTexts = contextMenuItemTexts,
      dynamicProps = dynamicProps,
      onLinkPress = onLinkPressCallback,
      onLinkLongPress = onLinkLongPressCallback,
      onTaskListItemPress = onTaskListItemPressCallback,
      onContextMenuItemPress = ::forwardContextMenuItemPress,
      onLatexError = latexErrorReporter,
    )

  /**
   * Root factory: builds child views through the shared creators, then layers on
   * root-only concerns (spoiler overlay mode, task-list toggle, streaming tail /
   * fade-in animation, and the pending code block sync for the open trailing
   * fence).
   */
  private inner class RootFactory : SegmentViewFactory {
    override fun matchesKind(
      view: View,
      segment: RenderedSegment,
    ): Boolean =
      when (segment) {
        is RenderedSegment.Text -> view is EnrichedMarkdownInternalText
        is RenderedSegment.Table -> view is TableContainerView
        is RenderedSegment.Math -> isMathContainerView(view)
        is RenderedSegment.CodeBlock -> view is CodeBlockContainerView
        is RenderedSegment.Blockquote -> view is BlockquoteContainerView
        is RenderedSegment.Video -> isVideoContainerView(view)
      }

    override fun createView(segment: RenderedSegment): View {
      val config = segmentViewConfig()
      return when (segment) {
        is RenderedSegment.Text -> {
          SegmentViewCreators.createTextView(segment, config).apply {
            spoilerOverlay = this@EnrichedMarkdown.spoilerOverlay
            enableTaskListItemToggle = this@EnrichedMarkdown.enableTaskListItemToggle
          }
        }

        is RenderedSegment.Table -> {
          SegmentViewCreators.createTableView(segment, config)
        }

        is RenderedSegment.Math -> {
          SegmentViewCreators.createMathView(segment, config)
        }

        is RenderedSegment.CodeBlock -> {
          SegmentViewCreators.createCodeBlockView(segment, config).apply {
            pending = segment === pendingCodeBlockSegment
          }
        }

        is RenderedSegment.Blockquote -> {
          SegmentViewCreators.createBlockquoteView(segment, config)
        }

        is RenderedSegment.Video -> {
          SegmentViewCreators.createVideoView(segment, config)
        }
      }
    }

    override fun updateView(
      view: View,
      segment: RenderedSegment,
    ) {
      when (segment) {
        is RenderedSegment.Text -> {
          val textView = view as EnrichedMarkdownInternalText
          val tailStart = textView.text?.length ?: 0
          SegmentViewCreators.updateTextView(textView, segment)
          animateTextViewTail(textView, tailStart)
        }

        is RenderedSegment.Table -> {
          val tableView = view as TableContainerView
          val previousRowCount = tableView.rowCount
          tableView.applyTableNode(segment.node)
          if (streamingAnimation && !isReducedMotionEnabled(context)) {
            tableView.animateNewRows(previousRowCount, BLOCK_FADE_DURATION_MS)
          }
        }

        is RenderedSegment.Math -> {
          SegmentViewCreators.updateMathView(view, segment)
        }

        is RenderedSegment.CodeBlock -> {
          (view as CodeBlockContainerView).apply {
            pending = segment === pendingCodeBlockSegment
            applyCodeBlockNode(segment.node)
          }
        }

        is RenderedSegment.Blockquote -> {
          (view as BlockquoteContainerView).applyBlockquoteNode(segment.node)
        }

        is RenderedSegment.Video -> {
          SegmentViewCreators.updateVideoView(view, segment)
        }
      }
    }

    override fun animateNewView(
      view: View,
      segment: RenderedSegment,
    ) {
      if (!streamingAnimation) return
      when (segment) {
        is RenderedSegment.Text -> animateTextViewTail(view as EnrichedMarkdownInternalText, 0)

        is RenderedSegment.Table,
        is RenderedSegment.Math,
        is RenderedSegment.CodeBlock,
        is RenderedSegment.Blockquote,
        is RenderedSegment.Video,
        -> animateBlockViewFadeIn(view)
      }
    }
  }

  private fun animateTextViewTail(
    view: EnrichedMarkdownInternalText,
    tailStart: Int,
  ) {
    if (!streamingAnimation) return
    val textLength = view.text?.length ?: 0
    if (textLength <= tailStart) return
    TailFadeInAnimator(view).animate(tailStart, textLength)
  }

  private fun animateBlockViewFadeIn(view: View) {
    if (!streamingAnimation) return
    if (isReducedMotionEnabled(context)) return
    view.alpha = 0f
    view
      .animate()
      .alpha(1f)
      .setDuration(BLOCK_FADE_DURATION_MS)
      .start()
  }

  private fun postToMain(
    renderId: Long,
    action: () -> Unit,
  ) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      if (renderId == currentRenderId) action()
    } else {
      mainHandler.post {
        if (renderId == currentRenderId) action()
      }
    }
  }

  override fun onLayout(
    changed: Boolean,
    l: Int,
    t: Int,
    r: Int,
    b: Int,
  ) {
    layoutSegments()
  }

  fun onImageLayoutChanged() {
    if (width > 0) {
      layoutSegments()
      requestLayout()
    }
    MeasurementStore.invalidate(id)
    val wrapper = stateWrapper ?: return
    val state = Arguments.createMap()
    state.putInt("forceHeightRecalculationCounter", ++forceHeightRecalculationCounter)
    wrapper.updateState(state)
  }

  fun cleanup() {
    executor.shutdownNow()
  }

  companion object {
    private const val TAG = "EnrichedMarkdown"
    private const val BLOCK_FADE_DURATION_MS = 200L
  }
}
