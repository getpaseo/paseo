package com.swmansion.enriched.markdown

import android.graphics.Typeface
import android.text.SpannableString
import android.text.StaticLayout
import android.text.TextPaint
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.spans.BaseListSpan
import com.swmansion.enriched.markdown.spans.ListMarkerAnchorSpan
import com.swmansion.enriched.markdown.spans.OrderedListSpan
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.test.MarkdownRenderTestSupport.render
import com.swmansion.enriched.markdown.test.MarkdownRenderTestSupport.styleConfig
import com.swmansion.enriched.markdown.test.MarkerCanvas
import com.swmansion.enriched.markdown.test.MarkerGeometry
import com.swmansion.enriched.markdown.test.TestAstFactory.listItem
import com.swmansion.enriched.markdown.test.TestAstFactory.orderedList
import com.swmansion.enriched.markdown.test.TestAstFactory.paragraph
import com.swmansion.enriched.markdown.test.TestAstFactory.taskListItem
import com.swmansion.enriched.markdown.test.TestAstFactory.text
import com.swmansion.enriched.markdown.test.TestAstFactory.unorderedList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.ceil

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ListRenderingTest {
  @Test
  fun shortListsKeepTheirIndentAndLongListsShareTheirWidestGutter() {
    val style = listStyle()
    val paint =
      TextPaint().apply {
        textSize = style.listStyle.fontSize
        typeface = Typeface.create("monospace", Typeface.NORMAL)
      }
    val baseline = paint.measureText("99.")
    val gap = style.listStyle.gapWidth
    val short = orderedSpans(style, numbered(1, 99))
    short.forEach { assertEquals((baseline + gap).toInt(), it.getLeadingMargin(false)) }
    for ((start, count) in listOf(1 to 250, 98 to 4, 998 to 4, 12345 to 4, 0 to 101)) {
      val spans = orderedSpans(style, numbered(start, count))
      val widest = maxOf(baseline, spans.maxOf { paint.measureText("${it.itemNumber}.") })
      spans.forEach { assertEquals((baseline + ceil(widest - baseline) + gap).toInt(), it.getLeadingMargin(false)) }
      assertTrue(spans.first().getLeadingMargin(false) > short.first().getLeadingMargin(false))
    }
  }

  @Test
  fun nestedAndFollowingListsRestoreTheirOwnGutters() {
    val style = listStyle()
    val spans = orderedSpans(style, withChild(numbered(98, 4), 0, numbered(9998, 4)), numbered(1, 1))
    val parent = spans.filter { it.depth == 0 && it.itemNumber != 1 }
    assertEquals(4, parent.size)
    parent.forEach { assertEquals(parent.first().getLeadingMargin(false), it.getLeadingMargin(false)) }
    spans.filter { it.depth == 1 }.forEach { assertTrue(it.getLeadingMargin(false) > style.listStyle.marginLeft) }
    val following = spans.single { it.depth == 0 && it.itemNumber == 1 }
    assertTrue(following.getLeadingMargin(false) < parent.first().getLeadingMargin(false))
  }

  @Test
  fun markerMinimumWidthRemainsAFloor() {
    val style = listStyle(minWidth = 200.0)
    orderedSpans(style, numbered(998, 4)).forEach {
      assertEquals((style.listStyle.markerMinWidth + style.listStyle.gapWidth).toInt(), it.getLeadingMargin(false))
    }
  }

  @Test
  fun drawnMarkersStayInsideTheGutterAndAttachedToTheirParagraphs() {
    val style = listStyle()
    for (start in listOf(1, 98, 9998)) {
      val threeLevels = withChild(numbered(1, 1), 0, numbered(1, 1))
      assertDrawnMarkerPositions(style, withChild(numbered(start, 4), 2, threeLevels))
    }
  }

  @Test
  fun nestedBulletColumnsKeepTheirGapUnderWideParents() {
    val style = listStyle()

    fun tree(start: Int) = withChild(numbered(start, 4), 2, unorderedList(item(), item()))
    for (start in listOf(98, 9998)) {
      assertNestedMarkerGapsUnchanged(style, tree(1), tree(start))
    }
  }

  @Test
  fun tasksMoveWithTheirWideNumberedSiblings() {
    val style = listStyle()

    fun tree(start: Int): MarkdownASTNode {
      val items = numbered(start, 3).children.toMutableList()
      items[1] = taskListItem(checked = false, paragraph(text("item")), numbered(1, 1))
      items[2] = listItem(paragraph(text("item")), numbered(1, 1))
      return orderedList(*items.toTypedArray(), start = start)
    }
    assertEveryRowShiftsTogether(style, tree(1), tree(12345))
  }

  @Test
  fun nestedTasksKeepTheirGapUnderWideNumericParents() {
    val style = listStyle()

    fun tree(start: Int) = withChild(numbered(start, 4), 2, orderedList(taskListItem(checked = false, paragraph(text("item")))))
    for (start in listOf(98, 9998)) {
      assertNestedMarkerGapsUnchanged(style, tree(1), tree(start))
    }
  }

  @Test
  fun sameTypeBulletAndTaskNestsKeepTheirMarkerGap() {
    val style = listStyle()
    val bullet = unorderedList(item())
    val task = orderedList(taskListItem(checked = false, paragraph(text("item"))))
    for (parent in listOf(bullet, task)) {
      assertDrawnMarkerPositions(style, withChild(parent, 0, parent))
    }
  }

  @Test
  fun mixedNestsStartTheirTextFromTheirOwnMarkerColumn() {
    val style = mixedStyle()
    // Each child's text sits one marginLeft plus its own column and gap in: 24 + (3, 22 or 14) + 6.
    val indents = mapOf(Kind.BULLET to 33f, Kind.ORDERED to 52f, Kind.TASK to 44f)
    for (parent in Kind.entries) {
      for (child in Kind.entries.filter { it != parent }) {
        for (checked in checkedStates(parent, child)) {
          val markers = drawMarkers(style, list(parent, list(child, checked = checked), checked))
          assertEquals(listOf(0, 1), markers.map { it.depth })
          assertEquals("$child under $parent", indents.getValue(child), markers.last().paragraphLeft, 0f)
          assertMixedGaps(markers, "$child under $parent, checked=$checked")
        }
      }
    }
  }

  @Test
  fun topLevelAndSameTypeNestsKeepTheirGeometry() {
    val style = mixedStyle()
    for (kind in Kind.entries) {
      val column = columnOf(style, kind)
      val markers = drawMarkers(style, list(kind, list(kind, list(kind))))
      assertEquals(listOf(0, 1, 2), markers.map { it.depth })
      markers.forEach {
        assertEquals("text for $kind at depth ${it.depth}", (column + MIXED_GAP).toInt() + it.depth * 24f, it.paragraphLeft, 0f)
        assertEquals(column + it.depth * 24f, it.marker.right, 0.01f)
      }
    }
  }

  @Test
  fun mixedColumnsUseAbsoluteIndentsWithoutFractionalDrift() {
    val alternating = listOf(Kind.BULLET, Kind.ORDERED, Kind.BULLET, Kind.TASK)
    val sameTypeRun = List(5) { Kind.BULLET } + Kind.TASK
    for (margin in listOf(24.0, 24.5, 4.0)) {
      val style = mixedStyle(bulletSize = 6.5, marginLeft = margin)
      for (kinds in listOf(alternating, sameTypeRun)) {
        val columns = kinds.map { columnOf(style, it) }
        val tree = kinds.dropLast(1).foldRight(list(kinds.last())) { kind, child -> list(kind, child) }
        val markers = drawMarkers(style, tree)
        assertEquals(kinds.indices.toList(), markers.map { it.depth })
        markers.forEach {
          val expected = (it.depth * margin + columns[it.depth] + MIXED_GAP).toInt().toFloat()
          assertEquals("absolute indent at depth ${it.depth} of $kinds, margin $margin", expected, it.paragraphLeft, 0f)
          assertEquals(it.paragraphLeft - MIXED_GAP, it.marker.right, 0.99f)
        }
      }
    }
  }

  @Test
  fun mixedAncestorsAndFollowingSiblingsRestoreTheirOwnColumns() {
    val style = mixedStyle()
    for (parent in Kind.entries) {
      val tree = list(parent).copy(children = Kind.entries.map { child -> item(parent, list(child, list(parent))) })
      assertMixedGaps(drawMarkers(style, tree, list(Kind.BULLET), list(Kind.ORDERED), list(Kind.TASK)), "under $parent")
    }
  }

  @Test
  fun mixedNestsAroundWideNumberedListsKeepTheirMarkerGap() {
    val style = mixedStyle()
    val wide = numbered(12345, 2)
    val wideWithTask = orderedList(item(), item(Kind.TASK, list(Kind.BULLET)), start = 998)
    val shapes =
      listOf(
        withChild(wide, 0, list(Kind.BULLET)),
        withChild(wide, 1, list(Kind.TASK, list(Kind.BULLET))),
        list(Kind.BULLET, wide),
        list(Kind.TASK, wide),
        withChild(numbered(998, 4), 3, withChild(wide, 0, list(Kind.BULLET))),
        list(Kind.BULLET, withChild(wide, 1, list(Kind.TASK))),
        withChild(wideWithTask, 0, list(Kind.BULLET)),
      )
    for ((index, shape) in shapes.withIndex()) {
      assertMixedGaps(drawMarkers(style, shape), "shape $index")
    }
  }

  @Test
  fun wrappedLinesKeepTheChildsOwnColumn() {
    val style = mixedStyle()
    val wrapped = orderedList(listItem(paragraph(text("wrapped child text ".repeat(12)))))
    val text = SpannableString(render(style, list(Kind.BULLET, wrapped)))
    val layout = StaticLayout.Builder.obtain(text, 0, text.length, TextPaint(), 180).build()
    val span = text.getSpans(0, text.length, OrderedListSpan::class.java).single()
    val firstLine = layout.getLineForOffset(text.getSpanStart(span))
    val lastLine = layout.getLineForOffset(text.getSpanEnd(span) - 1)
    assertTrue(lastLine > firstLine)
    val column = columnOf(style, Kind.ORDERED)
    for (line in firstLine..lastLine) {
      assertEquals((24f + column + MIXED_GAP).toInt(), layout.getParagraphLeft(line))
    }
    val markers = MarkerCanvas.drawMarkers(layout)
    assertEquals(2, markers.size)
    assertEquals(24f + column, markers.last().right, 0.01f)
  }

  @Test
  fun rtlMixedNestsKeepTheirMarkerGapAtEveryDepth() {
    fun rtl(node: MarkdownASTNode): MarkdownASTNode {
      if (node.type == MarkdownASTNode.NodeType.Text) return node.copy(content = "\u05e4\u05e8\u05d9\u05d8")
      return node.copy(children = node.children.map { rtl(it) })
    }

    val style = mixedStyle()
    for (parent in Kind.entries) {
      for (child in Kind.entries.filter { it != parent }) {
        for (checked in checkedStates(parent, child)) {
          val tree = list(parent, list(child, list(parent, checked = checked), checked), checked)
          val text = SpannableString(render(style, rtl(tree)))
          val markers = MarkerCanvas.markerGeometry(text, MarkerCanvas.layout(text, style.listStyle.fontSize, rtl = true))
          assertEquals(listOf(0, 1, 2), markers.map { it.depth })
          markers.forEach {
            assertEquals("RTL paragraph at depth ${it.depth}", -1, it.direction)
            // Bullets are centered on the column edge, so their recorded right is that edge in both directions.
            val kind = if (it.depth == 1) child else parent
            val edge = if (kind == Kind.BULLET) it.marker.right else it.marker.left
            assertEquals("$child under $parent, checked=$checked, depth ${it.depth}", it.paragraphRight + MIXED_GAP, edge, 0.01f)
          }
        }
      }
    }
  }

  @Test
  fun equalMinimumColumnsKeepTheirGeometryForMixedNests() {
    val style = mixedStyle(markerMinWidth = 40.0)
    for (parent in Kind.entries) {
      for (child in Kind.entries.filter { it != parent }) {
        val markers = drawMarkers(style, list(parent, list(child, list(parent))))
        assertEquals(listOf(0, 1, 2), markers.map { it.depth })
        markers.forEach {
          assertEquals("text for $child under $parent at depth ${it.depth}", 46f + it.depth * 24f, it.paragraphLeft, 0f)
          assertEquals(40f + it.depth * 24f, it.marker.right, 0.01f)
        }
      }
    }
  }

  @Test
  fun markersAnchoredOnANestedListKeepTheirAncestorsOffset() {
    val style = listStyle()
    // The middle item opens with its sublist, so its marker is drawn by an anchor span.
    val middle = orderedList(listItem(numbered(1, 1)), start = 1)
    val text = SpannableString(render(style, withChild(numbered(12345, 1), 0, middle)))
    assertEquals(1, text.getSpans(0, text.length, ListMarkerAnchorSpan::class.java).size)
    val markers = MarkerCanvas.drawMarkers(MarkerCanvas.layout(text, style.listStyle.fontSize))
    assertEquals(3, markers.size)
    val (root, anchored, leaf) = markers.sortedBy { it.right }
    assertEquals(root.right + style.listStyle.marginLeft, anchored.right, 0.01f)
    assertEquals(anchored.right + style.listStyle.marginLeft, leaf.right, 0.01f)
    assertTrue(markers.all { it.left >= 0f })
  }

  @Test
  fun inheritedMarkerOffsetsFollowTheRtlDirection() {
    val style = listStyle()
    val text = SpannableString(render(style, withChild(numbered(12345, 1), 0, numbered(1, 1))))
    val layout = MarkerCanvas.layout(text, style.listStyle.fontSize, rtl = true)
    val markers = MarkerCanvas.drawMarkers(layout)
    assertEquals(2, markers.size)
    markers.forEach { marker ->
      val line = layout.getLineForVertical(marker.baseline.toInt())
      assertEquals(-1, layout.getParagraphDirection(line))
      assertEquals(layout.getParagraphRight(line) + style.listStyle.gapWidth, marker.left, 0.01f)
      assertTrue(marker.right <= layout.width)
    }
  }

  private fun assertMixedGaps(
    markers: List<MarkerGeometry>,
    shape: String,
  ) {
    assertTrue(markers.isNotEmpty())
    markers.forEach {
      assertEquals("marker gap at depth ${it.depth}, $shape", it.paragraphLeft - MIXED_GAP, it.marker.right, 0.01f)
    }
  }

  private fun assertDrawnMarkerPositions(
    style: StyleConfig,
    vararg lists: MarkdownASTNode,
  ) {
    drawMarkers(style, *lists).forEach { geometry ->
      assertEquals(
        "marker right at depth ${geometry.depth}",
        geometry.paragraphLeft - style.listStyle.gapWidth,
        geometry.marker.right,
        0.01f,
      )
    }
  }

  /** The rows [wide] shares with [short], tasks and their children included, all sit [wide]'s widening further right. */
  private fun assertEveryRowShiftsTogether(
    style: StyleConfig,
    short: MarkdownASTNode,
    wide: MarkdownASTNode,
  ) {
    val shortRows = drawMarkers(style, short)
    val wideRows = drawMarkers(style, wide).take(shortRows.size)
    assertEquals(shortRows.size, wideRows.size)
    val shift = wideRows.first().paragraphLeft - shortRows.first().paragraphLeft
    assertTrue(shift > 0f)
    wideRows.zip(shortRows).forEach { (actual, control) ->
      assertEquals(control.depth, actual.depth)
      assertEquals("text shift at depth ${actual.depth}", shift, actual.paragraphLeft - control.paragraphLeft, 0.01f)
      assertEquals(
        "marker gap at depth ${actual.depth}",
        control.paragraphLeft - control.marker.right,
        actual.paragraphLeft - actual.marker.right,
        0.01f,
      )
    }
  }

  private fun assertNestedMarkerGapsUnchanged(
    style: StyleConfig,
    short: MarkdownASTNode,
    wide: MarkdownASTNode,
  ) {
    val shortMarkers = drawMarkers(style, short).filter { it.depth > 0 }
    val wideMarkers = drawMarkers(style, wide).filter { it.depth > 0 }
    assertTrue(shortMarkers.isNotEmpty())
    assertEquals(shortMarkers.size, wideMarkers.size)
    shortMarkers.zip(wideMarkers).forEach { (control, actual) ->
      assertEquals(control.depth, actual.depth)
      assertEquals(
        "nested marker gap at depth ${actual.depth}",
        control.paragraphLeft - control.marker.right,
        actual.paragraphLeft - actual.marker.right,
        0.01f,
      )
    }
  }

  private fun drawMarkers(
    style: StyleConfig,
    vararg lists: MarkdownASTNode,
  ): List<MarkerGeometry> {
    // SpannableString reports spans in insertion order, as the text view does.
    val text = SpannableString(render(style, *lists))
    val geometry = MarkerCanvas.markerGeometry(text, MarkerCanvas.layout(text, style.listStyle.fontSize))
    assertEquals(text.getSpans(0, text.length, BaseListSpan::class.java).count { it.drawsMarker }, geometry.size)
    geometry.forEach { assertTrue("marker left ${it.marker.left} at depth ${it.depth}", it.marker.left >= 0f) }
    return geometry
  }

  private fun orderedSpans(
    style: StyleConfig,
    vararg lists: MarkdownASTNode,
  ): List<OrderedListSpan> {
    val text = render(style, *lists)
    return text
      .getSpans(0, text.length, OrderedListSpan::class.java)
      .sortedWith(compareBy({ text.getSpanStart(it) }, { it.depth }))
  }

  private fun item(): MarkdownASTNode = listItem(paragraph(text("item")))

  private fun numbered(
    start: Int,
    count: Int,
  ): MarkdownASTNode = orderedList(*Array(count) { item() }, start = start)

  private fun withChild(
    list: MarkdownASTNode,
    index: Int,
    child: MarkdownASTNode,
  ): MarkdownASTNode {
    val items = list.children.toMutableList()
    items[index] = items[index].copy(children = items[index].children + child)
    return list.copy(children = items)
  }

  private fun listStyle(minWidth: Double = 0.0): StyleConfig =
    styleConfig(list = mapOf("fontFamily" to "monospace", "markerMinWidth" to minWidth))

  private enum class Kind { ORDERED, BULLET, TASK }

  private fun list(
    kind: Kind,
    child: MarkdownASTNode? = null,
    checked: Boolean = false,
  ): MarkdownASTNode {
    val item = item(kind, child, checked)
    return if (kind == Kind.ORDERED) orderedList(item) else unorderedList(item)
  }

  private fun item(
    kind: Kind,
    child: MarkdownASTNode? = null,
    checked: Boolean = false,
  ): MarkdownASTNode {
    val children = listOfNotNull(paragraph(text("item")), child).toTypedArray()
    return if (kind == Kind.TASK) taskListItem(checked, *children) else listItem(*children)
  }

  private fun checkedStates(
    parent: Kind,
    child: Kind,
  ) = if (parent == Kind.TASK || child == Kind.TASK) listOf(false, true) else listOf(false)

  /** The marker column [kind] reserves before any widening, read from a rendered top-level item. */
  private fun columnOf(
    style: StyleConfig,
    kind: Kind,
  ): Float {
    val text = render(style, list(kind))
    return text.getSpans(0, text.length, BaseListSpan::class.java).single().baselineMarkerWidth
  }

  private fun mixedStyle(
    markerMinWidth: Double = 0.0,
    bulletSize: Double = 6.0,
    marginLeft: Double = 24.0,
  ): StyleConfig =
    styleConfig(
      list =
        mapOf(
          "bulletSize" to bulletSize,
          "markerMinWidth" to markerMinWidth,
          "gapWidth" to MIXED_GAP.toDouble(),
          "marginLeft" to marginLeft,
        ),
      taskList = mapOf("checkboxSize" to 14.0),
    )

  private companion object {
    const val MIXED_GAP = 6f
  }
}
