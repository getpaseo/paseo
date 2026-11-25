package com.swmansion.enriched.markdown

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.ContextThemeWrapper
import android.view.View
import android.view.View.MeasureSpec
import android.widget.ImageButton
import com.facebook.react.bridge.JavaOnlyArray
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.swmansion.enriched.markdown.accessibility.AccessibilityLabels
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.parser.MarkdownASTNode.NodeType
import com.swmansion.enriched.markdown.segments.BlockquoteContainerView
import com.swmansion.enriched.markdown.segments.DynamicBlockProps
import com.swmansion.enriched.markdown.segments.SegmentViewConfig
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.test.TestAstFactory.listItem
import com.swmansion.enriched.markdown.test.TestAstFactory.paragraph
import com.swmansion.enriched.markdown.test.TestAstFactory.taskListItem
import com.swmansion.enriched.markdown.test.TestAstFactory.text
import com.swmansion.enriched.markdown.test.TestAstFactory.unorderedList
import com.swmansion.enriched.markdown.utils.text.view.SelectionMenuConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The copy control on a quote: what it copies, and where it shows. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(manifest = Config.NONE, sdk = [34])
class BlockquoteCopyTest {
  private val context: Context =
    ContextThemeWrapper(RuntimeEnvironment.getApplication(), androidx.appcompat.R.style.Theme_AppCompat)

  private fun quoteView(): BlockquoteContainerView {
    DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(context)
    // No border or background, so the copy glyph is the only thing a quote paints above its text.
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
      )
    val styles = JavaOnlyMap()
    ELEMENTS.forEach { styles.putMap(it, element) }
    styles.putArray("linkVariants", JavaOnlyArray())
    val style = StyleConfig(styles, context, false, 1f)
    val config =
      SegmentViewConfig(
        context = context,
        style = style,
        allowFontScaling = false,
        maxFontSizeMultiplier = 1f,
        accessibilityLabels = AccessibilityLabels(),
        selectionMenuConfig = SelectionMenuConfig(),
        textBreakStrategy = "simple",
        selectable = true,
        selectionColor = null,
        selectionHandleColor = null,
        contextMenuItemTexts = emptyList(),
        dynamicProps = DynamicBlockProps().apply { copyLabel = "Copy" },
        onLinkPress = null,
        onLinkLongPress = null,
        onTaskListItemPress = null,
        onContextMenuItemPress = null,
      )
    return BlockquoteContainerView(context, config)
  }

  private fun node(
    type: NodeType,
    vararg children: MarkdownASTNode,
    attributes: Map<String, String> = emptyMap(),
  ) = MarkdownASTNode(type, attributes = attributes, children = children.toList())

  private fun quote(vararg children: MarkdownASTNode) = node(NodeType.Blockquote, *children)

  private fun BlockquoteContainerView.copyButton(): ImageButton =
    (0 until childCount).map { getChildAt(it) }.filterIsInstance<ImageButton>().single()

  private fun BlockquoteContainerView.layoutAt(width: Int) {
    measure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
    )
    layout(0, 0, measuredWidth, measuredHeight)
  }

  private fun clipboardText(): String? {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    return clipboard.primaryClip?.getItemAt(0)?.text?.toString()
  }

  @Test fun copyButtonCopiesTheQuoteBodyWithItsFormatting() {
    val view = quoteView()
    view.applyBlockquoteNode(
      quote(
        paragraph(
          node(NodeType.Strong, text("Hello")),
          text(" team. See "),
          node(NodeType.Link, text("the PR"), attributes = mapOf("url" to "https://example.com/pr")),
          text(" - it's ready!"),
        ),
        quote(paragraph(text("Nested reply"))),
        unorderedList(
          taskListItem(true, paragraph(text("Done"))),
          taskListItem(false, paragraph(text("Pending"))),
          listItem(paragraph(text("Plain"))),
        ),
      ),
    )

    assertEquals("Copy", view.copyButton().contentDescription)
    view.copyButton().performClick()

    // Prose punctuation stays as written: a plain-text target shows backslashes literally.
    assertEquals(
      "**Hello** team. See [the PR](https://example.com/pr) - it's ready!\n\n" +
        "> Nested reply\n\n" +
        "- [x] Done\n- [ ] Pending\n- Plain",
      clipboardText(),
    )
  }

  @Test fun copyButtonCopiesTheLatestStreamedBody() {
    val view = quoteView()
    view.applyBlockquoteNode(quote(paragraph(text("First draft"))))
    view.applyBlockquoteNode(quote(paragraph(text("Second draft")), paragraph(text("With more"))))

    view.copyButton().performClick()

    assertEquals("Second draft\n\nWith more", clipboardText())
  }

  @Test fun codeBlockWithAnInnerFenceStaysOneBlock() {
    val view = quoteView()
    view.applyBlockquoteNode(
      quote(
        node(
          NodeType.CodeBlock,
          text("```js\nrun()\n```\n"),
          attributes = mapOf("language" to "markdown", "fenceChar" to "`"),
        ),
      ),
    )

    view.copyButton().performClick()

    assertEquals("````markdown\n```js\nrun()\n```\n````", clipboardText())
  }

  @Test fun nestedQuoteCopiesOnlyItsOwnBody() {
    val view = quoteView()
    view.applyBlockquoteNode(quote(paragraph(text("Outer")), quote(paragraph(text("Inner")))))
    val nested = (0 until view.childCount).map { view.getChildAt(it) }.filterIsInstance<BlockquoteContainerView>().single()

    nested.copyButton().performClick()

    assertEquals("Inner", clipboardText())
  }

  @Test fun admonitionHasNoCopyButton() {
    val view = quoteView()
    view.applyBlockquoteNode(
      node(NodeType.Admonition, paragraph(text("Careful")), attributes = mapOf("admonitionType" to "warning")),
    )

    assertEquals(View.GONE, view.copyButton().visibility)
  }

  @Test fun copyGlyphPaintsInsideTheHeaderBandAboveTheBody() {
    val view = quoteView()
    view.applyBlockquoteNode(quote(paragraph(text("Body"))))
    view.layoutAt(320)
    val button = view.copyButton()
    val body = view.getChildAt(0)

    assertTrue("The control sits above the body, not over it", button.bottom <= body.top)
    assertTrue("The control stays inside the quote", button.left >= 0 && button.right <= view.width && button.top >= 0)

    val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
    view.draw(Canvas(bitmap))
    val band = IntArray(view.width * body.top)
    bitmap.getPixels(band, 0, view.width, 0, 0, view.width, body.top)
    bitmap.recycle()
    assertTrue("The copy glyph must paint in the header band", band.any { Color.alpha(it) > 0 })
  }

  @Test fun emptyQuoteDisablesCopy() {
    val view = quoteView()
    view.applyBlockquoteNode(quote())

    assertFalse(view.copyButton().isEnabled)
  }

  private companion object {
    // Every element style the JS side sends; StyleConfig rejects a map that lacks one it reads.
    val ELEMENTS =
      listOf(
        "paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "strikethrough", "underline", "link",
        "code", "blockquote", "list", "codeBlock", "thematicBreak", "image", "inlineImage", "video", "table",
        "taskList", "math", "inlineMath", "spoiler", "superscript", "subscript", "highlight",
      )
  }
}
