package com.swmansion.enriched.markdown

import android.content.Context
import android.graphics.Color
import android.os.SystemClock
import android.text.Selection
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.view.ContextThemeWrapper
import android.view.MotionEvent
import android.view.View
import android.view.View.MeasureSpec
import android.view.ViewConfiguration
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ScrollView
import android.widget.TextView
import com.facebook.react.bridge.JavaOnlyArray
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.parser.MarkdownASTNode.NodeType
import com.swmansion.enriched.markdown.renderer.BlockStyle
import com.swmansion.enriched.markdown.renderer.SpanStyleCache
import com.swmansion.enriched.markdown.segments.TableContainerView
import com.swmansion.enriched.markdown.spans.LinkSpan
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.test.MarkdownRenderTestSupport.render
import com.swmansion.enriched.markdown.test.TestAstFactory.paragraph
import com.swmansion.enriched.markdown.test.TestAstFactory.taskListItem
import com.swmansion.enriched.markdown.test.TestAstFactory.text
import com.swmansion.enriched.markdown.test.TestAstFactory.unorderedList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Verifies Android parent touch-interception ownership during long-press selection drags and
 * link touches across EnrichedMarkdownInternalText, EnrichedMarkdownText, and TableContainerView.
 *
 * Regression for upstream software-mansion/enriched-markdown#1012: unconditionally calling
 * `requestDisallowInterceptTouchEvent(false)` on non-DOWN events undid Android Editor's
 * disallow request during long-press drag selection, letting a scrolling parent steal the touch
 * with `ACTION_CANCEL` and leaving the Android Magnifier stuck on screen.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(manifest = Config.NONE, sdk = [34])
class LongPressSelectionInterceptTest {
  private val context: Context =
    ContextThemeWrapper(RuntimeEnvironment.getApplication(), androidx.appcompat.R.style.Theme_AppCompat)

  private class RecordingParent(
    context: Context,
  ) : FrameLayout(context) {
    var disallowIntercept = false
      private set
    val calls = mutableListOf<Boolean>()

    override fun requestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {
      this.disallowIntercept = disallowIntercept
      calls.add(disallowIntercept)
      super.requestDisallowInterceptTouchEvent(disallowIntercept)
    }

    fun resetCalls() {
      calls.clear()
    }
  }

  private fun createStyleConfig(): StyleConfig {
    DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(context)
    val element =
      JavaOnlyMap.of(
        "fontFamily", "",
        "fontWeight", "normal",
        "fontStyle", "normal",
        "fontSize", 16.0,
        "lineHeight", 22.0,
        "color", Color.BLACK.toDouble(),
        "backgroundColor", 0.0,
        "borderColor", 0.0,
        "borderWidth", 0.0,
        "borderRadius", 0.0,
        "padding", 8.0,
        "gapWidth", 8.0,
        "marginTop", 0.0,
        "marginBottom", 0.0,
        "marginLeft", 20.0,
        "itemSpacing", 4.0,
        "bulletColor", Color.BLACK.toDouble(),
        "bulletSize", 6.0,
        "markerMinWidth", 0.0,
        "markerColor", Color.BLACK.toDouble(),
        "markerFontWeight", "normal",
        "textAlign", "left",
        "underline", false,
        "checkedColor", 0.0,
        "checkmarkColor", 0.0,
        "checkedTextColor", 0.0,
        "checkboxSize", 18.0,
        "checkboxBorderRadius", 2.0,
        "checkedStrikethrough", false,
        "particles", JavaOnlyMap.of("density", 1.0, "speed", 1.0),
        "solid", JavaOnlyMap.of("borderRadius", 0.0),
        "fontScale", 0.7,
        "baselineOffsetScale", 0.3,
        "headerFontFamily", "",
        "headerBackgroundColor", Color.LTGRAY.toDouble(),
        "headerTextColor", Color.BLACK.toDouble(),
        "rowEvenBackgroundColor", Color.WHITE.toDouble(),
        "rowOddBackgroundColor", Color.WHITE.toDouble(),
        "cellPaddingHorizontal", 8.0,
        "cellPaddingVertical", 4.0,
        "horizontalOverflow", 0.0,
        "align", "left",
      )
    val styles = JavaOnlyMap()
    ELEMENTS.forEach { styles.putMap(it, element) }
    styles.putArray("linkVariants", JavaOnlyArray())
    return StyleConfig(styles, context, false, 1f)
  }

  private fun layoutInParent(
    view: View,
    width: Int = 600,
  ): RecordingParent {
    val parent = RecordingParent(context)
    parent.addView(view)
    parent.measure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
    )
    parent.layout(0, 0, parent.measuredWidth, parent.measuredHeight)
    return parent
  }

  private fun pointOnChar(
    view: TextView,
    offset: Int,
  ): Pair<Float, Float> {
    val layout = requireNotNull(view.layout) { "TextView must be laid out before computing touch point" }
    val line = layout.getLineForOffset(offset)
    val x = view.totalPaddingLeft + layout.getPrimaryHorizontal(offset) + 2f
    val y = view.totalPaddingTop + (layout.getLineTop(line) + layout.getLineBottom(line)) / 2f
    return x to y
  }

  private fun motionEvent(
    downTime: Long,
    action: Int,
    x: Float,
    y: Float,
  ): MotionEvent = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0)

  private fun linkSpannable(
    text: String,
    linkEnd: Int,
    onPress: (String, String) -> Unit,
  ): SpannableStringBuilder {
    val style = createStyleConfig()
    val cache = SpanStyleCache(style)
    val blockStyle = BlockStyle(fontSize = 16f, fontFamily = "", fontWeight = "normal", color = Color.BLACK)
    return SpannableStringBuilder(text).apply {
      setSpan(
        LinkSpan(
          url = "https://example.com",
          onLinkPress = onPress,
          onLinkLongPress = null,
          styleCache = cache,
          blockStyle = blockStyle,
          context = context,
        ),
        0,
        linkEnd,
        Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
      )
    }
  }

  @Test
  fun proseLongPressDragKeepsParentInterceptDisallowedInInternalText() {
    val view = EnrichedMarkdownInternalText(context)
    view.applyStyledText(SpannableStringBuilder("Hello selectable world\nSecond line of prose"))
    val parent = layoutInParent(view)
    val (x, y) = pointOnChar(view, 2)
    val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    val downTime = SystemClock.uptimeMillis()

    view.onTouchEvent(motionEvent(downTime, MotionEvent.ACTION_DOWN, x, y))
    // Simulate Android Editor.SelectionModifierCursorController.enterDrag() claiming parent intercept.
    parent.requestDisallowInterceptTouchEvent(true)
    parent.resetCalls()

    view.onTouchEvent(motionEvent(downTime, MotionEvent.ACTION_MOVE, x, y + slop * 2f))

    assertTrue("Editor's disallow-intercept request must survive ACTION_MOVE on prose", parent.disallowIntercept)
    assertFalse("Must not release parent intercept that was not claimed for a link", parent.calls.contains(false))
  }

  @Test
  fun proseLongPressDragKeepsParentInterceptDisallowedInMarkdownText() {
    val view = EnrichedMarkdownText(context)
    view.setText(SpannableStringBuilder("Hello selectable world\nSecond line of prose"), TextView.BufferType.SPANNABLE)
    view.setIsSelectable(true)
    val parent = layoutInParent(view)
    val (x, y) = pointOnChar(view, 2)
    val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    val downTime = SystemClock.uptimeMillis()

    view.onTouchEvent(motionEvent(downTime, MotionEvent.ACTION_DOWN, x, y))
    parent.requestDisallowInterceptTouchEvent(true)
    parent.resetCalls()

    view.onTouchEvent(motionEvent(downTime, MotionEvent.ACTION_MOVE, x, y + slop * 2f))

    assertTrue("Editor's disallow-intercept request must survive ACTION_MOVE in EnrichedMarkdownText", parent.disallowIntercept)
    assertFalse("Must not release parent intercept that was not claimed for a link", parent.calls.contains(false))
  }

  @Test
  fun overflowingTableHorizontalDragKeepsParentInterceptDisallowedAndScrollsTable() {
    val table = TableContainerView(context, createStyleConfig())
    val cells =
      (1..6).map { i ->
        MarkdownASTNode(NodeType.TableCell, children = listOf(text("Column $i wide cell content")))
      }
    val row = MarkdownASTNode(NodeType.TableRow, children = cells)
    val body = MarkdownASTNode(NodeType.TableBody, children = listOf(row))
    table.applyTableNode(MarkdownASTNode(NodeType.Table, children = listOf(body)))
    val parent = layoutInParent(table, width = 240)

    val horizontalScrollView = findFirstViewOfType(table, HorizontalScrollView::class.java)
    assertTrue("Table must overflow horizontally to test scroll ownership", horizontalScrollView.canScrollHorizontally(1))

    val startX = table.width * 0.75f
    val startY = table.height / 2f
    val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    val downTime = SystemClock.uptimeMillis()

    table.dispatchTouchEvent(motionEvent(downTime, MotionEvent.ACTION_DOWN, startX, startY))
    assertTrue("Overflowing table must claim parent intercept on ACTION_DOWN", parent.disallowIntercept)
    parent.resetCalls()

    table.dispatchTouchEvent(motionEvent(downTime, MotionEvent.ACTION_MOVE, startX - slop * 2f, startY))
    table.dispatchTouchEvent(motionEvent(downTime, MotionEvent.ACTION_MOVE, startX - slop * 6f, startY))

    assertTrue("CellTextView must not release ClaimingHorizontalScrollView's disallow-intercept on horizontal drag", parent.disallowIntercept)
    assertFalse(parent.calls.contains(false))
    assertTrue("Intact table scroll view must scroll horizontally", horizontalScrollView.scrollX > 0)

    table.dispatchTouchEvent(motionEvent(downTime, MotionEvent.ACTION_UP, startX - slop * 6f, startY))
  }

  @Test
  fun verticalSwipeStartingOnCheckboxReleasesParentInterceptAndScrolls() {
    var tapped = false
    val style = createStyleConfig()
    val taskList =
      unorderedList(
        *(1..30)
          .map { i -> taskListItem(checked = false, paragraph(text("Review the draft item $i"))) }
          .toTypedArray(),
      )
    val view =
      EnrichedMarkdownInternalText(context).apply {
        enableTaskListItemToggle = true
        onTaskListItemPressCallback = { _, _, _ -> tapped = true }
        applyStyledText(render(style, taskList))
      }

    val scrollView = ScrollView(context)
    val parent = RecordingParent(context)
    parent.addView(view)
    scrollView.addView(parent)
    scrollView.measure(
      MeasureSpec.makeMeasureSpec(400, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(200, MeasureSpec.EXACTLY),
    )
    scrollView.layout(0, 0, scrollView.measuredWidth, scrollView.measuredHeight)

    val layout = requireNotNull(view.layout)
    // Pick a checkbox midway down the 200px viewport so an upward swipe stays inside bounds.
    val targetLine = 5
    val checkboxX = view.totalPaddingLeft + 8f
    val checkboxY = view.totalPaddingTop + (layout.getLineTop(targetLine) + layout.getLineBottom(targetLine)) / 2f
    val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    val downTime = SystemClock.uptimeMillis()

    scrollView.dispatchTouchEvent(motionEvent(downTime, MotionEvent.ACTION_DOWN, checkboxX, checkboxY))
    assertTrue("Checkbox press must claim parent intercept on ACTION_DOWN", parent.disallowIntercept)

    scrollView.dispatchTouchEvent(motionEvent(downTime, MotionEvent.ACTION_MOVE, checkboxX, checkboxY - slop * 2f))
    assertFalse("Moving past slop must release checkbox's disallow-intercept claim", parent.disallowIntercept)

    // ScrollView intercepts on the next move after disallow is released, then scrolls on subsequent moves.
    scrollView.dispatchTouchEvent(motionEvent(downTime, MotionEvent.ACTION_MOVE, checkboxX, checkboxY - slop * 4f))
    scrollView.dispatchTouchEvent(motionEvent(downTime, MotionEvent.ACTION_MOVE, checkboxX, checkboxY - slop * 8f))
    scrollView.dispatchTouchEvent(motionEvent(downTime, MotionEvent.ACTION_UP, checkboxX, checkboxY - slop * 8f))

    assertTrue("Parent ScrollView must scroll after vertical swipe starting on a checkbox", scrollView.scrollY > 0)
    assertFalse("Cancelled checkbox drag must not fire tap callback", tapped)
  }

  @Test
  fun linkTapDisallowsParentInterceptOnDownAndReleasesOnUp() {
    var pressedUrl: String? = null
    val view = EnrichedMarkdownInternalText(context)
    view.applyStyledText(linkSpannable("Example link prose", 12) { url, _ -> pressedUrl = url })
    val parent = layoutInParent(view)
    val (x, y) = pointOnChar(view, 2)
    val downTime = SystemClock.uptimeMillis()

    view.onTouchEvent(motionEvent(downTime, MotionEvent.ACTION_DOWN, x, y))
    assertTrue("Link press must claim parent intercept on ACTION_DOWN", parent.disallowIntercept)

    view.onTouchEvent(motionEvent(downTime, MotionEvent.ACTION_UP, x, y))
    assertEquals("https://example.com", pressedUrl)
    assertFalse("Link press must release parent intercept on ACTION_UP", parent.disallowIntercept)
  }

  @Test
  fun scrollStartingOnLinkReleasesParentInterceptPastTouchSlop() {
    var pressed = false
    val view = EnrichedMarkdownInternalText(context)
    view.applyStyledText(linkSpannable("Example link prose", 12) { _, _ -> pressed = true })
    val parent = layoutInParent(view)
    val (x, y) = pointOnChar(view, 2)
    val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    val downTime = SystemClock.uptimeMillis()

    view.onTouchEvent(motionEvent(downTime, MotionEvent.ACTION_DOWN, x, y))
    assertTrue(parent.disallowIntercept)

    view.onTouchEvent(motionEvent(downTime, MotionEvent.ACTION_MOVE, x, y + slop * 2f))
    assertFalse("Dragging past slop without selection must re-allow parent scroll", parent.disallowIntercept)
    assertFalse(pressed)
  }

  @Test
  fun longPressSelectionStartingOnLinkKeepsParentInterceptDisallowedPastSlop() {
    val view = EnrichedMarkdownInternalText(context)
    view.applyStyledText(linkSpannable("Example link prose", 12) { _, _ -> })
    val parent = layoutInParent(view)
    val (x, y) = pointOnChar(view, 2)
    val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    val downTime = SystemClock.uptimeMillis()

    view.onTouchEvent(motionEvent(downTime, MotionEvent.ACTION_DOWN, x, y))
    assertTrue(parent.disallowIntercept)

    // Simulate Editor starting a selection drag while the finger was held on the link/image.
    Selection.setSelection(view.text as Spannable, 0, 7)
    parent.requestDisallowInterceptTouchEvent(true)
    parent.resetCalls()

    view.onTouchEvent(motionEvent(downTime, MotionEvent.ACTION_MOVE, x, y + slop * 2f))
    assertTrue("Must not release parent intercept after Editor started selection during this touch", parent.disallowIntercept)
    assertFalse(parent.calls.contains(false))
  }

  @Test
  fun cancelledLinkTouchReleasesParentIntercept() {
    val view = EnrichedMarkdownInternalText(context)
    view.applyStyledText(linkSpannable("Example link prose", 12) { _, _ -> })
    val parent = layoutInParent(view)
    val (x, y) = pointOnChar(view, 2)
    val downTime = SystemClock.uptimeMillis()

    view.onTouchEvent(motionEvent(downTime, MotionEvent.ACTION_DOWN, x, y))
    assertTrue(parent.disallowIntercept)

    view.onTouchEvent(motionEvent(downTime, MotionEvent.ACTION_CANCEL, x, y))
    assertFalse("Cancelled link touch must release parent intercept", parent.disallowIntercept)
  }

  private fun <T : View> findFirstViewOfType(
    root: View,
    type: Class<T>,
  ): T {
    if (type.isInstance(root)) return type.cast(root)!!
    if (root is android.view.ViewGroup) {
      for (i in 0 until root.childCount) {
        runCatching { return findFirstViewOfType(root.getChildAt(i), type) }
      }
    }
    error("No ${type.simpleName} found under $root")
  }

  private companion object {
    val ELEMENTS =
      listOf(
        "paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "strikethrough", "underline", "link",
        "code", "blockquote", "list", "codeBlock", "thematicBreak", "image", "inlineImage", "video", "table",
        "taskList", "math", "inlineMath", "spoiler", "superscript", "subscript", "highlight",
      )
  }
}
