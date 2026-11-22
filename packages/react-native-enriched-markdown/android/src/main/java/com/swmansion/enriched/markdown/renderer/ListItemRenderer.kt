package com.swmansion.enriched.markdown.renderer

import android.text.SpannableStringBuilder
import android.text.style.ForegroundColorSpan
import android.text.style.StrikethroughSpan
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.spans.BaseListSpan
import com.swmansion.enriched.markdown.spans.CodeBlockSpan
import com.swmansion.enriched.markdown.spans.ListMarkerAnchorSpan
import com.swmansion.enriched.markdown.spans.OrderedListSpan
import com.swmansion.enriched.markdown.spans.TaskListSpan
import com.swmansion.enriched.markdown.spans.UnorderedListSpan
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_LIST_ITEM

class ListItemRenderer(
  private val config: RendererConfig,
) : NodeRenderer {
  override fun render(
    node: MarkdownASTNode,
    builder: SpannableStringBuilder,
    onLinkPress: ((String, String) -> Unit)?,
    onLinkLongPress: ((String) -> Unit)?,
    factory: RendererFactory,
  ) {
    val styleContext = factory.blockStyleContext
    val start = builder.length
    val listType = styleContext.listType ?: return

    val isTask = node.attributes["isTask"] == "true"
    val isChecked = isTask && node.attributes["taskChecked"] == "true"

    if (listType == BlockStyleContext.ListType.ORDERED) {
      styleContext.incrementListItemNumber()
    }

    val taskIndex = if (isTask) styleContext.taskItemCount++ else -1

    val depth = styleContext.listDepth - 1
    val listStyle = config.style.listStyle

    fun makeSpan(drawsMarker: Boolean): BaseListSpan =
      if (isTask) {
        TaskListSpan(
          taskStyle = config.style.taskListStyle,
          listStyle = listStyle,
          depth = depth,
          context = factory.context,
          styleCache = factory.styleCache,
          taskIndex = taskIndex,
          isChecked = isChecked,
          drawsMarker = drawsMarker,
        )
      } else {
        when (listType) {
          BlockStyleContext.ListType.UNORDERED -> {
            UnorderedListSpan(listStyle, depth, factory.context, factory.styleCache, drawsMarker)
          }

          BlockStyleContext.ListType.ORDERED -> {
            OrderedListSpan(listStyle, depth, factory.context, factory.styleCache, drawsMarker).apply {
              setItemNumber(styleContext.listItemNumber)
            }
          }
        }
      }

    val markerSpan = makeSpan(drawsMarker = true)

    val prevIndent = styleContext.accumulatedIndent
    styleContext.accumulatedIndent = prevIndent + markerSpan.getLeadingMargin(false)
    try {
      factory.renderChildren(node, builder, onLinkPress, onLinkLongPress)
    } finally {
      styleContext.accumulatedIndent = prevIndent
    }

    if (builder.length == start || builder.substring(start).isBlank()) return

    styleContext.listItemStarts.add(start)

    if (builder.last() != '\n') {
      builder.append("\n")
    }

    val itemEnd = builder.length

    // Anchor the marker on the first content character so items that open with
    // a code block or nested sublist still get their marker.
    var anchor = start
    while (anchor < itemEnd && builder[anchor].isWhitespace()) anchor++
    if (anchor == itemEnd) anchor = start

    val plainAnchor =
      builder.getSpans(anchor, anchor + 1, CodeBlockSpan::class.java).isEmpty() &&
        builder.getSpans(anchor, anchor + 1, BaseListSpan::class.java).none { it.depth > depth }

    val codeBlockRanges =
      builder
        .getSpans(start, itemEnd, CodeBlockSpan::class.java)
        .map { builder.getSpanStart(it) to builder.getSpanEnd(it) }
        .filter { it.first < it.second }
        .sortedBy { it.first }

    var pos = start
    var isFirstSegment = true
    for ((cbStart, cbEnd) in codeBlockRanges) {
      if (pos < cbStart) {
        builder.setSpan(
          if (isFirstSegment && plainAnchor) markerSpan else makeSpan(drawsMarker = false),
          pos,
          cbStart,
          SPAN_FLAGS_LIST_ITEM,
        )
        isFirstSegment = false
      }
      pos = maxOf(pos, cbEnd)
    }
    if (pos < itemEnd) {
      builder.setSpan(
        if (isFirstSegment && plainAnchor) markerSpan else makeSpan(drawsMarker = false),
        pos,
        itemEnd,
        SPAN_FLAGS_LIST_ITEM,
      )
    }

    if (!plainAnchor) {
      builder.setSpan(ListMarkerAnchorSpan(markerSpan), anchor, anchor + 1, SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE)
    }

    if (isTask && isChecked) {
      applyCheckedDecorations(builder, start, itemEnd, depth)
    }
  }

  private fun applyCheckedDecorations(
    builder: SpannableStringBuilder,
    itemStart: Int,
    itemEnd: Int,
    itemDepth: Int,
  ) {
    val taskStyle = config.style.taskListStyle
    val checkedTextColor = taskStyle.checkedTextColor
    val strikethrough = taskStyle.checkedStrikethrough

    if (checkedTextColor == 0 && !strikethrough) return

    val excludedRanges =
      (
        builder.getSpans(itemStart, itemEnd, BaseListSpan::class.java).filter { it.depth > itemDepth } +
          builder.getSpans(itemStart, itemEnd, CodeBlockSpan::class.java).toList()
      ).map { builder.getSpanStart(it) to builder.getSpanEnd(it) }
        .sortedBy { it.first }

    var currentPos = itemStart

    for ((start, end) in excludedRanges) {
      if (start > currentPos) {
        applySpans(builder, currentPos, start, checkedTextColor, strikethrough)
      }
      currentPos = maxOf(currentPos, end)
    }

    if (currentPos < itemEnd) {
      applySpans(builder, currentPos, itemEnd, checkedTextColor, strikethrough)
    }
  }

  private fun applySpans(
    builder: SpannableStringBuilder,
    start: Int,
    end: Int,
    color: Int,
    strikethrough: Boolean,
  ) {
    if (color != 0) {
      builder.setSpan(ForegroundColorSpan(color), start, end, SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE)
    }
    if (strikethrough) {
      builder.setSpan(StrikethroughSpan(), start, end, SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE)
    }
  }
}
