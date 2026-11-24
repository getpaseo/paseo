package com.swmansion.enriched.markdown.segments

import android.content.Context
import android.view.View
import android.widget.FrameLayout
import kotlin.math.ceil
import kotlin.math.max

/**
 * Reusable view for an AST branch node that holds a vertical stack of block
 * children (the document root and every blockquote). It owns the machinery
 * shared by both: reconciling a list of RenderedSegment into real child views
 * by signature, stacking them vertically with per-segment margins, and
 * reporting the total height (including its own vertical padding).
 *
 * Per-kind view construction is delegated to a SegmentViewFactory the subclass
 * supplies, so root-only wiring (link/copy callbacks, selection menu, spoiler,
 * accessibility, task-list toggle, pending code block) lives with the root and
 * the nested blockquote factory reuses only the shared creators.
 *
 * Layout honors paddingLeft/Top/Right/Bottom so a subclass can inset its
 * children (e.g. a blockquote's border/gap/padding) via padding: children are
 * measured at exactly width - paddingLeft - paddingRight and laid out starting
 * at (paddingLeft, paddingTop). The root uses zero padding, so its behavior is
 * unchanged.
 */
open class ContainerNodeView(
  context: Context,
) : FrameLayout(context) {
  protected val segmentViews = mutableListOf<View>()
  protected val segmentSignatures = mutableListOf<Long>()

  protected lateinit var segmentViewFactory: SegmentViewFactory

  protected var trailingMarginEnabled: Boolean = false

  /**
   * Reconciles the current child views against renderedSegments, attaching and
   * removing views as needed and updating segmentViews/segmentSignatures.
   * Returns whether the topology changed (any view attached or removed).
   */
  protected fun applySegments(
    renderedSegments: List<RenderedSegment>,
    reset: Boolean,
  ): Boolean {
    val result =
      SegmentReconciler.reconcile(
        currentViews = segmentViews.toList(),
        currentSignatures = segmentSignatures.toList(),
        renderedSegments = renderedSegments,
        reset = reset,
        matchesKind = segmentViewFactory::matchesKind,
        createView = { segment ->
          val view = segmentViewFactory.createView(segment)
          segmentViewFactory.animateNewView(view, segment)
          view
        },
        updateView = { view, segment -> segmentViewFactory.updateView(view, segment) },
      )

    result.viewsToRemove.forEach { removeView(it) }
    result.viewsToAttach.forEach { addView(it) }

    // Only created views are appended, so a signature-based reorder would leave
    // getChildAt out of step with segmentViews. detach/attach splices the child array
    // without a detach-from-window pass, so a moved child keeps its selection, focus
    // and scroll state; each step fixes one index without disturbing the ones before it.
    result.views.forEachIndexed { index, view ->
      if (getChildAt(index) !== view) {
        detachViewFromParent(view)
        attachViewToParent(view, index, view.layoutParams)
      }
    }

    segmentViews.clear()
    segmentViews.addAll(result.views)
    segmentSignatures.clear()
    segmentSignatures.addAll(result.signatures)

    return result.viewsToAttach.isNotEmpty() || result.viewsToRemove.isNotEmpty()
  }

  protected fun layoutSegments() {
    val containerWidth = width
    if (containerWidth <= 0) return

    val contentWidth = (containerWidth - paddingLeft - paddingRight).coerceAtLeast(0)

    val needsOverhang =
      segmentViews.any { view ->
        view is TableContainerView &&
          ceil(view.tableStyle.horizontalOverflow.toDouble()).toInt() > 0
      }
    if (clipChildren == needsOverhang) {
      clipChildren = !needsOverhang
    }

    var currentY = paddingTop
    val lastIndex = segmentViews.lastIndex
    val widthSpec = MeasureSpec.makeMeasureSpec(contentWidth, MeasureSpec.EXACTLY)
    val heightSpec = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)

    segmentViews.forEachIndexed { index, view ->
      val segment = view as? BlockSegmentView
      val shouldAddBottomMargin = index != lastIndex || trailingMarginEnabled

      currentY += segment?.segmentMarginTop ?: 0

      val overhang =
        if (view is TableContainerView) {
          max(ceil(view.tableStyle.horizontalOverflow.toDouble()).toInt(), 0)
        } else {
          0
        }

      if (overhang > 0) {
        val extendedWidth = contentWidth + overhang * 2
        val extWidthSpec = MeasureSpec.makeMeasureSpec(extendedWidth, MeasureSpec.EXACTLY)
        view.measure(extWidthSpec, heightSpec)
        view.layout(
          paddingLeft - overhang,
          currentY,
          paddingLeft + contentWidth + overhang,
          currentY + view.measuredHeight,
        )
      } else {
        view.measure(widthSpec, heightSpec)
        view.layout(paddingLeft, currentY, paddingLeft + contentWidth, currentY + view.measuredHeight)
      }
      currentY += view.measuredHeight

      if (shouldAddBottomMargin) {
        currentY += segment?.segmentMarginBottom ?: 0
      }
    }
  }

  /**
   * Measures every child at the inner content width so computeSegmentsTotalHeight
   * can read accurate measuredHeights during a subclass's onMeasure, before the
   * onLayout pass runs layoutSegments. Without this a container that sizes itself
   * from its children (a blockquote) would measure them as zero-height and clip.
   */
  protected fun measureSegmentChildren(outerWidth: Int) {
    val contentWidth = (outerWidth - paddingLeft - paddingRight).coerceAtLeast(0)
    val widthSpec = MeasureSpec.makeMeasureSpec(contentWidth, MeasureSpec.EXACTLY)
    val heightSpec = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
    segmentViews.forEach { it.measure(widthSpec, heightSpec) }
  }

  protected fun computeSegmentsTotalHeight(): Int {
    var totalHeight = paddingTop + paddingBottom
    val lastIndex = segmentViews.lastIndex
    segmentViews.forEachIndexed { index, view ->
      val segment = view as? BlockSegmentView
      totalHeight += segment?.segmentMarginTop ?: 0
      totalHeight += view.measuredHeight
      if (index != lastIndex || trailingMarginEnabled) {
        totalHeight += segment?.segmentMarginBottom ?: 0
      }
    }
    return totalHeight
  }
}
