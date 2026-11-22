package com.swmansion.enriched.markdown.segments

import android.content.Context
import android.graphics.Paint
import android.os.Build
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.utils.text.extensions.replaceMathSpansWithPlaceholders
import com.swmansion.enriched.markdown.utils.text.span.prepareWidthAwareSpans
import kotlin.math.ceil

/**
 * View-free height summation for a vertical stack of RenderedSegments at a fixed
 * content width, single-sourced so the shadow-node measurement pass
 * (MeasurementStore) and the blockquote container's own static measurer report
 * identical heights.
 *
 * Math heights must be measured up front on the main thread by the caller and
 * supplied through mathHeightForIndex, because the summation runs off the main
 * thread. Blockquote children recurse through
 * BlockquoteContainerView.measureBlockquoteNodeHeight.
 */
object SegmentHeightMeasurer {
  fun measureSegmentsHeight(
    segments: List<RenderedSegment>,
    style: StyleConfig,
    context: Context,
    contentWidthPx: Float,
    fontSizePx: Float,
    breakStrategy: Int,
    allowTrailingMargin: Boolean,
    mathHeightForIndex: (Int) -> Float,
  ): Float {
    val widthPx = ceil(contentWidthPx).toInt().coerceAtLeast(1)
    val lastIndex = segments.lastIndex
    var totalHeightPx = 0f

    for ((index, segment) in segments.withIndex()) {
      val isLastSegment = index == lastIndex
      val includeBottomMargin = if (isLastSegment) allowTrailingMargin else true

      when (segment) {
        is RenderedSegment.Text -> {
          segment.styledText.replaceMathSpansWithPlaceholders(context)
          val layout = createStaticLayout(segment.styledText, fontSizePx, widthPx, breakStrategy)
          totalHeightPx += layout.height
          if (includeBottomMargin) {
            totalHeightPx += segment.lastElementMarginBottom
          }
        }

        is RenderedSegment.Table -> {
          totalHeightPx += style.tableStyle.marginTop
          totalHeightPx += TableContainerView.measureTableNodeHeight(segment.node, style, context)
          if (includeBottomMargin) {
            totalHeightPx += style.tableStyle.marginBottom
          }
        }

        is RenderedSegment.Math -> {
          totalHeightPx += style.mathStyle.marginTop
          totalHeightPx += mathHeightForIndex(index)
          if (includeBottomMargin) {
            totalHeightPx += style.mathStyle.marginBottom
          }
        }

        is RenderedSegment.CodeBlock -> {
          totalHeightPx += style.codeBlockStyle.marginTop
          totalHeightPx += CodeBlockContainerView.measureCodeBlockNodeHeight(segment.node, style, context, contentWidthPx)
          if (includeBottomMargin) {
            totalHeightPx += style.codeBlockStyle.marginBottom
          }
        }

        is RenderedSegment.Blockquote -> {
          // A quote encountered here is always nested inside another quote, so it
          // carries no vertical margin (only the outermost quote does, added by
          // MeasurementStore); this mirrors BlockquoteContainerView.nested.
          totalHeightPx += BlockquoteContainerView.measureBlockquoteNodeHeight(segment.node, style, context, contentWidthPx)
        }

        is RenderedSegment.Video -> {
          totalHeightPx += style.videoStyle.marginTop
          totalHeightPx += contentWidthPx / style.videoStyle.resolvedAspectRatio
          if (includeBottomMargin) {
            totalHeightPx += style.videoStyle.marginBottom
          }
        }
      }
    }
    return totalHeightPx
  }

  fun createStaticLayout(
    text: CharSequence,
    fontSizePx: Float,
    widthPx: Int,
    breakStrategy: Int,
  ): StaticLayout {
    val paint =
      TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = fontSizePx
      }
    prepareWidthAwareSpans(text, widthPx)
    return StaticLayout.Builder
      .obtain(text, 0, text.length, paint, widthPx)
      .setIncludePad(false)
      .setLineSpacing(0f, 1f)
      .apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          @Suppress("WrongConstant")
          setBreakStrategy(breakStrategy)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          setUseLineSpacingFromFallbacks(true)
        }
      }.build()
  }
}
