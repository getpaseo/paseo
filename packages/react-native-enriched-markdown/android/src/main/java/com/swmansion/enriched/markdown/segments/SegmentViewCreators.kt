package com.swmansion.enriched.markdown.segments

import android.content.Context
import android.os.Build
import android.text.Layout
import android.util.Log
import android.util.TypedValue
import android.view.View
import com.swmansion.enriched.markdown.EnrichedMarkdownInternalText
import com.swmansion.enriched.markdown.accessibility.AccessibilityLabels
import com.swmansion.enriched.markdown.math.LatexErrorReporter
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.utils.common.BreakStrategyUtils
import com.swmansion.enriched.markdown.utils.common.FeatureFlags
import com.swmansion.enriched.markdown.utils.text.view.SelectionMenuConfig
import com.swmansion.enriched.markdown.utils.text.view.applySelectionColors

/**
 * Runtime-mutable block props that a prop update can flip WITHOUT recreating the
 * segment tree (the reconcile path, reset = false): the block context-menu gate,
 * the code-block tap gate, the copy menu labels, and the copy/tap callbacks.
 *
 * The root owns one instance and mutates it in place; every view down the tree
 * holds the same reference (SegmentViewConfig.dynamicProps) and reads a field at use-time
 * (menu-open, tap). That single shared box is the source of truth, so a view
 * created after a toggle (e.g. a code block added to a blockquote once
 * onCodeBlockPress is on) is born current instead of from a stale snapshot, and
 * no per-toggle push into existing views is needed. See issues #768 and #822.
 *
 * Only props read at interaction-time, with no layout/draw dependency, belong
 * here; anything that rebuilds the tree on change stays an immutable field on
 * SegmentViewConfig, where a snapshot can never go stale.
 */
class DynamicBlockProps {
  var enableBlockContextMenu: Boolean = true
  var enableCodeBlockPress: Boolean = false
  var copyLabel: String = ""
  var copyAsMarkdownLabel: String = ""
  var onCopyPress: ((code: String, language: String) -> Unit)? = null
  var onCodeBlockPress: ((code: String, language: String) -> Unit)? = null
}

/**
 * Configuration shared by every ContainerNodeView's SegmentViewFactory so that
 * Text / Table / Math / CodeBlock / Blockquote child views are constructed the
 * same way regardless of the host (root document or nested blockquote).
 *
 * The root supplies the full wiring; a nested blockquote supplies the subset it
 * needs (styling, link/copy callbacks, accessibility labels) and treats
 * streaming as static.
 *
 * Everything here is a fixed-for-the-view's-life value: changing any of it
 * recreates the tree (see EnrichedMarkdown.setMarkdownStyle et al.), so a
 * snapshot never goes stale. The runtime-mutable block props live in [dynamicProps].
 */
data class SegmentViewConfig(
  val context: Context,
  val style: StyleConfig,
  val allowFontScaling: Boolean,
  val maxFontSizeMultiplier: Float,
  val accessibilityLabels: AccessibilityLabels,
  val selectionMenuConfig: SelectionMenuConfig,
  val textBreakStrategy: String,
  val selectable: Boolean,
  val selectionColor: Int?,
  val selectionHandleColor: Int?,
  val contextMenuItemTexts: List<String>,
  val dynamicProps: DynamicBlockProps,
  val onLinkPress: ((String, String) -> Unit)?,
  val onLinkLongPress: ((String) -> Unit)?,
  val onTaskListItemPress: ((taskIndex: Int, checked: Boolean, itemText: String) -> Unit)?,
  val onContextMenuItemPress: ((itemText: String, selectedText: String, selectionStart: Int, selectionEnd: Int) -> Unit)?,
  val onLatexError: LatexErrorReporter? = null,
)

/**
 * Pure per-kind child view creators used by both the root and nested factories.
 * Kept free of host-only concerns (streaming tail animation, pending fence
 * handling, spoiler overlay mode, task-list toggle) so the root can add those on
 * top while nested blockquotes reuse the exact same construction.
 */
object SegmentViewCreators {
  private const val TAG = "SegmentViewCreators"

  fun createTextView(
    segment: RenderedSegment.Text,
    config: SegmentViewConfig,
  ): EnrichedMarkdownInternalText =
    EnrichedMarkdownInternalText(config.context).apply {
      selectionMenuConfig = config.selectionMenuConfig
      accessibilityLabels = config.accessibilityLabels
      setIsSelectable(config.selectable)
      setTextSize(TypedValue.COMPLEX_UNIT_PX, config.style.paragraphStyle.fontSize)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        breakStrategy = BreakStrategyUtils.resolveBreakStrategy(config.textBreakStrategy)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && segment.needsJustify) {
        justificationMode = Layout.JUSTIFICATION_MODE_INTER_WORD
      }
      lastElementMarginBottom = segment.lastElementMarginBottom
      applyStyledText(segment.styledText)
      segment.imageSpans.forEach { it.registerTextView(this) }

      onTaskListItemPressCallback = { taskIndex, checked, itemText ->
        config.onTaskListItemPress?.invoke(taskIndex, checked, itemText)
      }

      if (config.contextMenuItemTexts.isNotEmpty()) {
        val onPress = config.onContextMenuItemPress
        if (onPress != null) {
          setContextMenuItems(config.contextMenuItemTexts) { itemText, selectedText, start, end ->
            onPress(itemText, selectedText, start, end)
          }
        }
      }

      applySelectionColors(config.selectionColor, config.selectionHandleColor)
    }

  fun updateTextView(
    view: EnrichedMarkdownInternalText,
    segment: RenderedSegment.Text,
  ) {
    view.lastElementMarginBottom = segment.lastElementMarginBottom
    view.applyStyledText(segment.styledText)
    segment.imageSpans.forEach { it.registerTextView(view) }
  }

  fun createTableView(
    segment: RenderedSegment.Table,
    config: SegmentViewConfig,
  ) = TableContainerView(config.context, config.style).apply {
    dynamicProps = config.dynamicProps
    allowFontScaling = config.allowFontScaling
    maxFontSizeMultiplier = config.maxFontSizeMultiplier
    accessibilityLabels = config.accessibilityLabels
    onLinkPress = config.onLinkPress
    onLinkLongPress = config.onLinkLongPress
    applyTableNode(segment.node)
  }

  fun createCodeBlockView(
    segment: RenderedSegment.CodeBlock,
    config: SegmentViewConfig,
  ) = CodeBlockContainerView(config.context, config.style).apply {
    dynamicProps = config.dynamicProps
    applyCodeBlockNode(segment.node)
  }

  // Availability is fixed at build time (the math source set is compiled in or not), so the
  // reflective lookup - including the ClassNotFoundException when math is disabled - is resolved
  // once instead of on every reconcile via isMathContainerView/matchesKind.
  private val cachedMathContainerClass: Class<*>? by lazy {
    try {
      Class.forName("com.swmansion.enriched.markdown.segments.MathContainerView")
    } catch (_: Exception) {
      null
    }
  }

  fun mathContainerClass(): Class<*>? = cachedMathContainerClass

  fun isMathContainerView(view: View): Boolean = cachedMathContainerClass?.isInstance(view) == true

  fun createMathView(
    segment: RenderedSegment.Math,
    config: SegmentViewConfig,
  ): View {
    val resolvedClass = mathContainerClass()
    if (!FeatureFlags.IS_MATH_ENABLED || resolvedClass == null) return View(config.context)
    return try {
      val view =
        resolvedClass
          .getConstructor(Context::class.java, StyleConfig::class.java)
          .newInstance(config.context, config.style) as View
      runCatching {
        resolvedClass
          .getMethod("setAccessibilityLabels", AccessibilityLabels::class.java)
          .invoke(view, config.accessibilityLabels)
      }
      resolvedClass
        .getMethod("setDynamicProps", DynamicBlockProps::class.java)
        .invoke(view, config.dynamicProps)
      runCatching {
        resolvedClass
          .getMethod("setOnLatexError", LatexErrorReporter::class.java)
          .invoke(view, config.onLatexError)
      }
      resolvedClass.getMethod("applyLatex", String::class.java).invoke(view, segment.latex)
      view
    } catch (e: Exception) {
      Log.e(TAG, "Failed to create math view", e)
      View(config.context)
    }
  }

  fun updateMathView(
    view: View,
    segment: RenderedSegment.Math,
  ) {
    mathContainerClass()
      ?.getMethod("applyLatex", String::class.java)
      ?.invoke(view, segment.latex)
  }

  fun createBlockquoteView(
    segment: RenderedSegment.Blockquote,
    config: SegmentViewConfig,
  ) = BlockquoteContainerView(config.context, config).apply {
    applyBlockquoteNode(segment.node)
  }

  private val cachedVideoContainerClass: Class<*>? by lazy {
    try {
      Class.forName("com.swmansion.enriched.markdown.segments.VideoContainerView")
    } catch (_: Exception) {
      null
    }
  }

  fun videoContainerClass(): Class<*>? = cachedVideoContainerClass

  fun isVideoContainerView(view: View): Boolean = cachedVideoContainerClass?.isInstance(view) == true

  fun createVideoView(
    segment: RenderedSegment.Video,
    config: SegmentViewConfig,
  ): View {
    val resolvedClass = videoContainerClass()
    if (!FeatureFlags.IS_VIDEO_ENABLED || resolvedClass == null) return View(config.context)
    return try {
      val view =
        resolvedClass
          .getConstructor(Context::class.java, StyleConfig::class.java)
          .newInstance(config.context, config.style) as View
      resolvedClass
        .getMethod("setDynamicProps", DynamicBlockProps::class.java)
        .invoke(view, config.dynamicProps)
      resolvedClass
        .getMethod("applyVideoNode", MarkdownASTNode::class.java)
        .invoke(view, segment.node)
      view
    } catch (e: Exception) {
      Log.e(TAG, "Failed to create video view", e)
      View(config.context)
    }
  }

  fun updateVideoView(
    view: View,
    segment: RenderedSegment.Video,
  ) {
    videoContainerClass()
      ?.getMethod("applyVideoNode", MarkdownASTNode::class.java)
      ?.invoke(view, segment.node)
  }
}
