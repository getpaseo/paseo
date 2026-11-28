package com.swmansion.enriched.markdown

import android.text.Spanned
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.swmansion.enriched.markdown.accessibility.AccessibleMarkdownTextView
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.spans.BaseListSpan
import com.swmansion.enriched.markdown.spans.ListMarkerAnchorSpan
import com.swmansion.enriched.markdown.spans.TaskListSpan
import com.swmansion.enriched.markdown.test.DrawnMarker
import com.swmansion.enriched.markdown.test.MarkdownRenderTestSupport.render
import com.swmansion.enriched.markdown.test.MarkdownRenderTestSupport.styleConfig
import com.swmansion.enriched.markdown.test.MarkerCanvas
import com.swmansion.enriched.markdown.test.TestAstFactory.listItem
import com.swmansion.enriched.markdown.test.TestAstFactory.orderedList
import com.swmansion.enriched.markdown.test.TestAstFactory.paragraph
import com.swmansion.enriched.markdown.test.TestAstFactory.taskListItem
import com.swmansion.enriched.markdown.test.TestAstFactory.text
import com.swmansion.enriched.markdown.test.TestAstFactory.unorderedList
import com.swmansion.enriched.markdown.utils.text.interaction.TaskListTapUtils
import com.swmansion.enriched.markdown.utils.text.view.setupAsMarkdownTextView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TaskListInteractionTest {
  private val context = RuntimeEnvironment.getApplication()

  @Test
  fun togglingATaskUnderAWideParentKeepsEveryMarginAndMarkerPosition() {
    assertTaskToggleKeepsGeometry(wideParentTree(opensWithSublist = false), anchors = 0, markers = 4)
  }

  @Test
  fun togglingAnAnchoredTaskUnderAWideParentKeepsEveryMarginAndMarkerPosition() {
    assertTaskToggleKeepsGeometry(wideParentTree(opensWithSublist = true), anchors = 1, markers = 4)
  }

  @Test
  fun togglingATaskInAMixedNestKeepsEveryMarginAndMarkerPosition() {
    // The task's indent depends on its parent's marker column, so the toggled copy has to keep it.
    val tasks = unorderedList(taskListItem(checked = false, paragraph(text("item")), numbered(1)))
    val parent = listItem(paragraph(text("item")), tasks)
    for (tree in listOf(unorderedList(parent), orderedList(parent))) {
      assertTaskToggleKeepsGeometry(tree, anchors = 0, markers = 3)
    }
  }

  private fun wideParentTree(opensWithSublist: Boolean): MarkdownASTNode {
    val taskChildren = if (opensWithSublist) arrayOf(numbered(1)) else arrayOf(paragraph(text("item")), numbered(1))
    val task = taskListItem(checked = false, *taskChildren)
    return orderedList(listItem(paragraph(text("item")), unorderedList(task)), item(), start = 100)
  }

  // Layout draws leading margins in span insertion order, so a toggle that re-adds only the
  // task's span would move its checkbox by its ancestors' margins.
  private fun assertTaskToggleKeepsGeometry(
    tree: MarkdownASTNode,
    anchors: Int,
    markers: Int,
  ) {
    val style = styleConfig(list = mapOf("fontFamily" to "monospace"))
    val textView =
      object : AccessibleMarkdownTextView(context) {}.apply {
        layoutParams = ViewGroup.LayoutParams(MarkerCanvas.LAYOUT_WIDTH, ViewGroup.LayoutParams.WRAP_CONTENT)
        setupAsMarkdownTextView()
      }
    textView.setText(render(style, tree), TextView.BufferType.SPANNABLE)
    val initialText = textView.text as Spanned
    val taskIndex = initialText.getSpans(0, initialText.length, TaskListSpan::class.java).single().taskIndex
    assertEquals(anchors, initialText.getSpans(0, initialText.length, ListMarkerAnchorSpan::class.java).size)
    val initialMargins = listMargins(initialText)
    val initialMarkers = drawTextViewMarkers(textView)
    assertEquals(markers, initialMarkers.size)

    for (checked in listOf(true, false)) {
      assertTrue(TaskListTapUtils.updateTaskListItemCheckedState(textView, taskIndex, checked, style))
      val text = textView.text as Spanned
      val tasks = text.getSpans(0, text.length, TaskListSpan::class.java)
      assertTrue(tasks.isNotEmpty())
      tasks.forEach { assertEquals(checked, it.isChecked) }
      text.getSpans(0, text.length, ListMarkerAnchorSpan::class.java).forEach {
        assertEquals(checked, (it.marker as TaskListSpan).isChecked)
      }
      assertEquals("list margins after checked=$checked", initialMargins, listMargins(text))
      assertEquals("drawn markers after checked=$checked", initialMarkers, drawTextViewMarkers(textView))
    }
  }

  private fun listMargins(text: Spanned): List<List<Int>> =
    text
      .getSpans(0, text.length, BaseListSpan::class.java)
      .sortedWith(compareBy({ text.getSpanStart(it) }, { it.depth }, { text.getSpanEnd(it) }))
      .map { listOf(text.getSpanStart(it), text.getSpanEnd(it), it.depth, it.getLeadingMargin(true), it.getLeadingMargin(false)) }

  private fun drawTextViewMarkers(textView: TextView): List<DrawnMarker> {
    textView.forceLayout()
    textView.measure(
      View.MeasureSpec.makeMeasureSpec(MarkerCanvas.LAYOUT_WIDTH, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
    )
    textView.layout(0, 0, textView.measuredWidth, textView.measuredHeight)
    return MarkerCanvas.drawMarkers(textView.layout)
  }

  private fun item(): MarkdownASTNode = listItem(paragraph(text("item")))

  private fun numbered(count: Int): MarkdownASTNode = orderedList(*Array(count) { item() }, start = 1)
}
