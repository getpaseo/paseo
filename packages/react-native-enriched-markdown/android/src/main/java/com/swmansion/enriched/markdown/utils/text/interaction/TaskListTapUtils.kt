package com.swmansion.enriched.markdown.utils.text.interaction

import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StrikethroughSpan
import android.widget.TextView
import com.swmansion.enriched.markdown.renderer.SpanStyleCache
import com.swmansion.enriched.markdown.spans.BaseListSpan
import com.swmansion.enriched.markdown.spans.CodeBlockSpan
import com.swmansion.enriched.markdown.spans.ListMarkerAnchorSpan
import com.swmansion.enriched.markdown.spans.TaskListSpan
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE

data class TaskListHitTestResult(
  val taskIndex: Int,
  val checked: Boolean,
  val itemText: String,
)

object TaskListToggleUtils {
  private val TASK_PATTERN = Regex("""^([ \t]*[-*+][ \t]+)\[[ xX]]""", RegexOption.MULTILINE)

  fun toggleAtIndex(
    markdown: String,
    index: Int,
    checked: Boolean,
  ): String {
    val matches = TASK_PATTERN.findAll(markdown).toList()
    if (index < 0 || index >= matches.size) return markdown

    val match = matches[index]
    val prefix = match.groupValues[1]

    val replacement = "$prefix[${if (checked) "x" else " "}]"

    return markdown.replaceRange(match.range, replacement)
  }
}

object TaskListTapUtils {
  fun hitTest(
    textView: TextView,
    rawX: Float,
    rawY: Float,
  ): TaskListHitTestResult? =
    with(textView) {
      val layout = layout ?: return null
      val spannable = text as? Spanned ?: return null

      val x = rawX.toInt() - totalPaddingLeft + scrollX
      val y = rawY.toInt() - totalPaddingTop + scrollY

      val line = layout.getLineForVertical(y)

      val taskSpan =
        spannable
          .getSpans(
            layout.getLineStart(line),
            layout.getLineEnd(line),
            TaskListSpan::class.java,
          ).maxByOrNull { it.depth } ?: return null

      val isRtl = layout.getParagraphDirection(line) == android.text.Layout.DIR_RIGHT_TO_LEFT
      if (isRtl) {
        val lineRight = layout.getLineRight(line).toInt()
        val indentWidth = lineRight - layout.getParagraphRight(line).toInt()
        if (x <= layout.width - indentWidth) return null
      } else {
        val lineLeft = layout.getLineLeft(line).toInt()
        val indentWidth = layout.getParagraphLeft(line).toInt() - lineLeft
        if (x >= indentWidth) return null
      }

      val spanStart = spannable.getSpanStart(taskSpan)
      val spanEnd = spannable.getSpanEnd(taskSpan)

      val itemText =
        spannable
          .subSequence(spanStart, spanEnd)
          .toString()
          .substringBefore('\n')
          .trim()

      return TaskListHitTestResult(
        taskIndex = taskSpan.taskIndex,
        checked = taskSpan.isChecked,
        itemText = itemText,
      )
    }

  fun updateTaskListItemCheckedState(
    textView: TextView,
    targetIndex: Int,
    newChecked: Boolean,
    styleConfig: StyleConfig,
  ): Boolean {
    val text = textView.text
    if (text !is Spannable) {
      return false
    }

    val spannable = SpannableStringBuilder(text)
    val targetSpans =
      spannable
        .getSpans(0, spannable.length, TaskListSpan::class.java)
        .filter { it.taskIndex == targetIndex }
    if (targetSpans.isEmpty()) {
      return false
    }

    if (targetSpans.all { it.isChecked == newChecked }) {
      return true
    }

    val itemDepth = targetSpans.first().depth
    val spanStart = targetSpans.minOf { spannable.getSpanStart(it) }
    val spanEnd = targetSpans.maxOf { spannable.getSpanEnd(it) }

    val styleCache = SpanStyleCache(styleConfig)

    fun toggledCopy(old: TaskListSpan): TaskListSpan =
      TaskListSpan(
        taskStyle = styleConfig.taskListStyle,
        listStyle = styleConfig.listStyle,
        depth = old.depth,
        context = textView.context,
        styleCache = styleCache,
        taskIndex = targetIndex,
        isChecked = newChecked,
        drawsMarker = old.drawsMarker,
      )

    // Replace every segment of the item — spans are split around code blocks
    for (old in targetSpans) {
      val start = spannable.getSpanStart(old)
      val end = spannable.getSpanEnd(old)
      // Keep the original flags so the list item priority survives the toggle
      val flags = spannable.getSpanFlags(old)
      spannable.removeSpan(old)
      spannable.setSpan(toggledCopy(old), start, end, flags)
    }

    // The marker may be drawn by an anchor span wrapping an unattached copy
    spannable
      .getSpans(0, spannable.length, ListMarkerAnchorSpan::class.java)
      .filter { (it.marker as? TaskListSpan)?.taskIndex == targetIndex }
      .forEach { old ->
        val start = spannable.getSpanStart(old)
        val end = spannable.getSpanEnd(old)
        spannable.removeSpan(old)
        spannable.setSpan(
          ListMarkerAnchorSpan(toggledCopy(old.marker as TaskListSpan)),
          start,
          end,
          SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
        )
      }

    val taskStyle = styleConfig.taskListStyle
    val checkedTextColor = taskStyle.checkedTextColor
    val strikethrough = taskStyle.checkedStrikethrough

    val excludedRanges =
      (
        spannable.getSpans(spanStart, spanEnd, BaseListSpan::class.java).filter { it.depth > itemDepth } +
          spannable.getSpans(spanStart, spanEnd, CodeBlockSpan::class.java).toList()
      ).map { spannable.getSpanStart(it) to spannable.getSpanEnd(it) }
        .sortedBy { it.first }

    applyDecorationsToRanges(
      spannable = spannable,
      spanStart = spanStart,
      spanEnd = spanEnd,
      excludedRanges = excludedRanges,
      isChecked = newChecked,
      checkedTextColor = checkedTextColor,
      strikethrough = strikethrough,
      styleConfig = styleConfig,
    )

    val imageSpans = text.getSpans(0, text.length, com.swmansion.enriched.markdown.spans.ImageSpan::class.java).toList()
    val originalSpanStarts = imageSpans.associateWith { text.getSpanStart(it) }

    textView.text = spannable

    val newImageSpans = spannable.getSpans(0, spannable.length, com.swmansion.enriched.markdown.spans.ImageSpan::class.java)
    imageSpans.forEach { originalSpan ->
      val matchingSpan =
        newImageSpans.firstOrNull {
          it.imageUrl == originalSpan.imageUrl &&
            spannable.getSpanStart(it) == originalSpanStarts[originalSpan]
        }
      (matchingSpan ?: originalSpan).registerTextView(textView)
    }

    textView.invalidate()

    return true
  }

  private fun applyDecorationsToRanges(
    spannable: Spannable,
    spanStart: Int,
    spanEnd: Int,
    excludedRanges: List<Pair<Int, Int>>,
    isChecked: Boolean,
    checkedTextColor: Int,
    strikethrough: Boolean,
    styleConfig: StyleConfig,
  ) {
    var currentPos = spanStart
    for ((start, end) in excludedRanges) {
      if (start > currentPos) {
        if (isChecked) {
          applyCheckedSpans(spannable, currentPos, start, checkedTextColor, strikethrough)
        } else {
          removeCheckedSpans(spannable, currentPos, start, styleConfig)
        }
      }
      currentPos = maxOf(currentPos, end)
    }
    if (currentPos < spanEnd) {
      if (isChecked) {
        applyCheckedSpans(spannable, currentPos, spanEnd, checkedTextColor, strikethrough)
      } else {
        removeCheckedSpans(spannable, currentPos, spanEnd, styleConfig)
      }
    }
  }

  private fun applyCheckedSpans(
    spannable: Spannable,
    start: Int,
    end: Int,
    color: Int,
    strikethrough: Boolean,
  ) {
    if (color != 0) {
      spannable.setSpan(ForegroundColorSpan(color), start, end, SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE)
    }
    if (strikethrough) {
      spannable.setSpan(StrikethroughSpan(), start, end, SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE)
    }
  }

  private fun removeCheckedSpans(
    spannable: Spannable,
    start: Int,
    end: Int,
    styleConfig: StyleConfig,
  ) {
    val strikethroughSpans = spannable.getSpans(start, end, StrikethroughSpan::class.java)
    strikethroughSpans.forEach { spannable.removeSpan(it) }

    val colorSpans = spannable.getSpans(start, end, ForegroundColorSpan::class.java)
    colorSpans.forEach { spannable.removeSpan(it) }

    val listStyleColor = styleConfig.listStyle.color
    if (listStyleColor != 0) {
      spannable.setSpan(
        ForegroundColorSpan(listStyleColor),
        start,
        end,
        Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
      )
    }
  }
}
