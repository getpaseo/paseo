package com.swmansion.enriched.markdown.segments

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.view.View
import androidx.core.graphics.withSave
import com.facebook.react.common.ReactConstants
import com.facebook.react.views.text.ReactTypefaceUtils.applyStyles
import com.swmansion.enriched.markdown.EnrichedMarkdownInternalText
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.styles.BlockquoteStyle
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.utils.common.BreakStrategyUtils
import com.swmansion.enriched.markdown.utils.common.serialization.MarkdownASTSerializer
import com.swmansion.enriched.markdown.views.ContextMenuPopup
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * A GFM blockquote rendered as a recursive container: it splits its own AST
 * children into segments and lays them out through the shared ContainerNodeView
 * machinery, so a nested quote becomes another BlockquoteContainerView, a fenced
 * code block becomes a CodeBlockContainerView, and prose collapses into a single
 * text view. Nesting depth is automatic: each level is its own view, inset
 * further by its padding, so onDraw only ever renders one accent bar plus the
 * background for this single level.
 *
 * The content inset is applied as this view's padding (left = borderWidth +
 * gapWidth + padding, other edges = padding), mirroring the geometry
 * BlockquoteSpan draws for the in-text (list-nested) path; the base measure and
 * layout already honor padding.
 *
 * Streaming is treated as static inside a quote (no pending-fence handling, no
 * tail/fade animation) to keep the recursion tractable; a content change re-signs
 * the whole container so the reconciler still reuses the outer quote view.
 */
class BlockquoteContainerView(
  context: Context,
  private val parentConfig: SegmentViewConfig,
) : ContainerNodeView(context),
  BlockSegmentView {
  private val blockquoteStyle: BlockquoteStyle = parentConfig.style.blockquoteStyle

  private val borderWidthPx: Float = blockquoteStyle.borderWidth
  private val paddingPx: Float = blockquoteStyle.padding
  private val leftInset: Int = ceil(borderWidthPx + blockquoteStyle.gapWidth + paddingPx).toInt()
  private val verticalInset: Int = ceil(paddingPx).toInt()
  private val rightInset: Int = ceil(paddingPx).toInt()

  // Set from the applied node: null for a plain quote, the admonition type
  // ("note"/"tip"/…) otherwise. Drives the header + per-type theming.
  private var admonitionType: String? = null

  // Cached markdown source for the "Copy as Markdown" action.
  private var cachedMarkdown: String = ""

  // Cached plain text for the "Copy" action.
  private var cachedPlainText: String = ""

  private val iconSizePx: Int = ceil(blockquoteStyle.fontSize).toInt()

  private val titlePaint =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      typeface =
        Typeface.create(
          applyStyles(
            null,
            ReactConstants.UNSET,
            ReactConstants.UNSET,
            blockquoteStyle.fontFamily.takeIf { it.isNotEmpty() },
            context.assets,
          ),
          Typeface.BOLD,
        )
      textSize = blockquoteStyle.fontSize
    }
  private val iconPaint =
    Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }

  private fun reservedHeaderHeight(): Int = if (admonitionType != null) ceil(admonitionHeaderReservedHeight(blockquoteStyle)).toInt() else 0

  // Only the outermost quote carries vertical margins; a quote nested directly
  // inside another quote is separated by the parent's padding alone (matches the
  // commonmark BlockquoteRenderer, which applies margins only at depth 0).
  var nested: Boolean = false

  override val segmentMarginTop: Int get() = if (nested) 0 else blockquoteStyle.marginTop.toInt()
  override val segmentMarginBottom: Int get() = if (nested) 0 else blockquoteStyle.marginBottom.toInt()

  private val backgroundPaint =
    Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val borderPaint =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.FILL
      color = blockquoteStyle.borderColor
    }
  private val rect = RectF()
  private val path = Path()
  private val radiiArray = FloatArray(8)

  init {
    setWillNotDraw(false)
    setPadding(leftInset, verticalInset, rightInset, verticalInset)
    segmentViewFactory = ChildFactory()
    trailingMarginEnabled = false
    isLongClickable = true
    setOnLongClickListener { view -> showContextMenu(view) }
  }

  fun applyBlockquoteNode(node: MarkdownASTNode) {
    admonitionType =
      if (node.type == MarkdownASTNode.NodeType.Admonition) {
        node.getAttribute("admonitionType")?.takeIf { it.isNotEmpty() } ?: "note"
      } else {
        null
      }
    // Reserve the header band above the body by enlarging the top padding.
    setPadding(leftInset, verticalInset + reservedHeaderHeight(), rightInset, verticalInset)

    cachedMarkdown = MarkdownASTSerializer.serializeBlockquote(node)
    cachedPlainText = MarkdownASTSerializer.plainText(node)

    val segments = splitASTIntoSegments(node)
    val rendered =
      MarkdownSegmentRenderer.render(
        segments,
        parentConfig.style,
        context,
        parentConfig.onLinkPress,
        parentConfig.onLinkLongPress,
        blockquoteStyle,
        onLatexError = parentConfig.onLatexError,
      )
    applySegments(rendered, reset = false)
    requestLayout()
  }

  private fun showContextMenu(anchor: View): Boolean {
    if (!parentConfig.dynamicProps.enableBlockContextMenu) return false
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    ContextMenuPopup.show(anchor, this) {
      item(ContextMenuPopup.Icon.COPY, parentConfig.dynamicProps.copyLabel) {
        if (cachedPlainText.isNotEmpty()) {
          clipboard.setPrimaryClip(ClipData.newPlainText("Blockquote", cachedPlainText))
        }
      }
      item(ContextMenuPopup.Icon.DOCUMENT, parentConfig.dynamicProps.copyAsMarkdownLabel) {
        if (cachedMarkdown.isNotEmpty()) {
          clipboard.setPrimaryClip(ClipData.newPlainText("Blockquote", cachedMarkdown))
        }
      }
    }
    return true
  }

  override fun onMeasure(
    widthSpec: Int,
    heightSpec: Int,
  ) {
    val measuredWidth = MeasureSpec.getSize(widthSpec)
    measureSegmentChildren(measuredWidth)
    setMeasuredDimension(measuredWidth, computeSegmentsTotalHeight())
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

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val radius = blockquoteStyle.borderRadius
    val hasRadius = radius > 0f

    // Admonitions theme the box with their per-type color; a plain quote keeps
    // the base blockquote colors.
    val type = admonitionType
    val tint =
      if (type != null) {
        blockquoteStyle.admonitions[type]?.color ?: blockquoteStyle.borderColor
      } else {
        blockquoteStyle.borderColor
      }
    val bgColor =
      if (type != null) {
        blockquoteStyle.admonitions[type]?.backgroundColor?.takeIf { it != Color.TRANSPARENT }
      } else {
        blockquoteStyle.backgroundColor?.takeIf { it != Color.TRANSPARENT }
      }
    borderPaint.color = tint

    if (hasRadius) {
      rect.set(0f, 0f, width.toFloat(), height.toFloat())
      radiiArray.fill(radius)
      path.reset()
      path.addRoundRect(rect, radiiArray, Path.Direction.CW)
    }

    if (bgColor != null) {
      backgroundPaint.color = bgColor
      if (hasRadius) {
        canvas.drawPath(path, backgroundPaint)
      } else {
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), backgroundPaint)
      }
    }

    // Clip the accent bar to the rounded box so its top-left/bottom-left corners
    // follow the border radius instead of poking past the background as squares.
    if (hasRadius) {
      canvas.withSave {
        clipPath(path)
        drawRect(0f, 0f, borderWidthPx, height.toFloat(), borderPaint)
      }
    } else {
      canvas.drawRect(0f, 0f, borderWidthPx, height.toFloat(), borderPaint)
    }

    if (type != null) {
      drawAdmonitionHeader(canvas, type, tint)
    }
  }

  // Draws the admonition header (tinted octicon + capitalized title) in the band
  // reserved at the top of the view by the enlarged top padding.
  private fun drawAdmonitionHeader(
    canvas: Canvas,
    type: String,
    tint: Int,
  ) {
    val headerTop = verticalInset.toFloat()
    val headerHeight = admonitionHeaderContentHeight(blockquoteStyle)
    var titleX = leftInset.toFloat()

    val iconPath = AdmonitionIcons.path(type)
    if (iconPath != null) {
      val scale = iconSizePx / AdmonitionIcons.VIEWBOX
      val iconY = headerTop + (headerHeight - iconSizePx) / 2f
      iconPaint.color = tint
      canvas.withSave {
        translate(leftInset.toFloat(), iconY)
        scale(scale, scale)
        drawPath(iconPath, iconPaint)
      }
      titleX = (leftInset + iconSizePx + (iconSizePx * 0.4f).roundToInt()).toFloat()
    }

    titlePaint.color = tint
    val fm = titlePaint.fontMetrics
    val baseline = headerTop + headerHeight / 2f - (fm.ascent + fm.descent) / 2f
    canvas.drawText(AdmonitionIcons.title(type), titleX, baseline, titlePaint)
  }

  /**
   * Factory for this quote's own children. It reuses the shared creators for
   * every kind and, for a nested Blockquote, creates another
   * BlockquoteContainerView (the recursion). Streaming is static here: no
   * animation, no pending-fence sync.
   */
  private inner class ChildFactory : SegmentViewFactory {
    override fun matchesKind(
      view: View,
      segment: RenderedSegment,
    ): Boolean =
      when (segment) {
        is RenderedSegment.Text -> view is EnrichedMarkdownInternalText
        is RenderedSegment.Table -> view is TableContainerView
        is RenderedSegment.Math -> SegmentViewCreators.isMathContainerView(view)
        is RenderedSegment.CodeBlock -> view is CodeBlockContainerView
        is RenderedSegment.Blockquote -> view is BlockquoteContainerView
        is RenderedSegment.Video -> SegmentViewCreators.isVideoContainerView(view)
      }

    override fun createView(segment: RenderedSegment): View =
      when (segment) {
        is RenderedSegment.Text -> {
          SegmentViewCreators.createTextView(segment, parentConfig)
        }

        is RenderedSegment.Table -> {
          SegmentViewCreators.createTableView(segment, parentConfig)
        }

        is RenderedSegment.Math -> {
          SegmentViewCreators.createMathView(segment, parentConfig)
        }

        is RenderedSegment.CodeBlock -> {
          SegmentViewCreators.createCodeBlockView(segment, parentConfig)
        }

        is RenderedSegment.Blockquote -> {
          SegmentViewCreators.createBlockquoteView(segment, parentConfig).apply { nested = true }
        }

        is RenderedSegment.Video -> {
          SegmentViewCreators.createVideoView(segment, parentConfig)
        }
      }

    override fun updateView(
      view: View,
      segment: RenderedSegment,
    ) {
      when (segment) {
        is RenderedSegment.Text -> SegmentViewCreators.updateTextView(view as EnrichedMarkdownInternalText, segment)
        is RenderedSegment.Table -> (view as TableContainerView).applyTableNode(segment.node)
        is RenderedSegment.Math -> SegmentViewCreators.updateMathView(view, segment)
        is RenderedSegment.CodeBlock -> (view as CodeBlockContainerView).applyCodeBlockNode(segment.node)
        is RenderedSegment.Blockquote -> (view as BlockquoteContainerView).applyBlockquoteNode(segment.node)
        is RenderedSegment.Video -> SegmentViewCreators.updateVideoView(view, segment)
      }
    }

    override fun animateNewView(
      view: View,
      segment: RenderedSegment,
    ) = Unit
  }

  companion object {
    // Height of the header band (icon + title row). Shared by the instance draw
    // path and the view-free measurement so both reserve identical space.
    fun admonitionHeaderContentHeight(style: BlockquoteStyle): Float = ceil(max(ceil(style.fontSize), style.fontSize * 1.35f))

    // Vertical space the header adds above the body (band + gap).
    fun admonitionHeaderReservedHeight(style: BlockquoteStyle): Float =
      admonitionHeaderContentHeight(style) + (style.fontSize * 0.4f).roundToInt()

    /**
     * View-free height of a blockquote node at the given outer content width.
     * The children are summed at the reduced inner width (outer minus horizontal
     * inset) and the vertical inset is added; nested quotes recurse through this
     * same function via SegmentHeightMeasurer. Math child heights use the shared
     * estimate to avoid a main-thread measure from the layout pass.
     *
     * Potential win: this runs splitASTIntoSegments + render for measurement, and
     * applyBlockquoteNode runs them again for display, so each nesting level renders
     * its content twice. The two passes run on different threads (this one off the
     * main thread, view creation on it) and key off different widths, so a shared
     * cache would need to be thread-safe and width-aware; not worth it yet, but the
     * rendered segments could be memoized so the view path reuses this result.
     */
    fun measureBlockquoteNodeHeight(
      node: MarkdownASTNode,
      config: StyleConfig,
      context: Context,
      width: Float,
    ): Float {
      val style = config.blockquoteStyle
      val leftInset = ceil(style.borderWidth + style.gapWidth + style.padding).toInt()
      val rightInset = ceil(style.padding).toInt()
      val verticalInset = ceil(style.padding).toInt()
      val headerReserved =
        if (node.type == MarkdownASTNode.NodeType.Admonition) {
          ceil(admonitionHeaderReservedHeight(style))
        } else {
          0f
        }
      val innerWidth = (width - leftInset - rightInset).coerceAtLeast(1f)

      val segments = splitASTIntoSegments(node)
      val rendered = MarkdownSegmentRenderer.render(segments, config, context, null, null, style)

      val fontSize = style.fontSize
      val breakStrategy = BreakStrategyUtils.resolveBreakStrategy(null)

      val childrenHeight =
        SegmentHeightMeasurer.measureSegmentsHeight(
          segments = rendered,
          style = config,
          context = context,
          contentWidthPx = innerWidth,
          fontSizePx = fontSize,
          breakStrategy = breakStrategy,
          allowTrailingMargin = false,
          mathHeightForIndex = { estimateMathHeight(config) },
        )

      return childrenHeight + verticalInset * 2f + headerReserved
    }

    private fun estimateMathHeight(config: StyleConfig): Float {
      val estimatedHeight = config.mathStyle.fontSize * 1.4f
      return estimatedHeight + config.mathStyle.padding * 2
    }
  }
}
