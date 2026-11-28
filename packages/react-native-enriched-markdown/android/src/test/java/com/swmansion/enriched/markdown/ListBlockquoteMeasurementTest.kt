package com.swmansion.enriched.markdown

import android.graphics.Paint
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.style.LineHeightSpan as AndroidLineHeightSpan
import android.util.TypedValue
import android.view.View.MeasureSpec
import com.facebook.react.bridge.JavaOnlyArray
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.parser.MarkdownASTNode.NodeType
import com.swmansion.enriched.markdown.renderer.Renderer
import com.swmansion.enriched.markdown.segments.SegmentHeightMeasurer
import com.swmansion.enriched.markdown.spans.LineHeightSpan
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(manifest = Config.NONE, sdk = [34])
class ListBlockquoteMeasurementTest {
  private fun styleConfig(): StyleConfig {
    val context = RuntimeEnvironment.getApplication()
    DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(context)
    val base =
      JavaOnlyMap.of(
        "fontFamily", "",
        "fontWeight", "normal",
        "fontStyle", "normal",
        "fontSize", 16.0,
        "lineHeight", 22.0,
        "color", -16777216.0,
        "backgroundColor", 0.0,
        "borderColor", 0.0,
        "borderWidth", 3.0,
        "borderRadius", 0.0,
        "padding", 12.0,
        "gapWidth", 8.0,
        "marginTop", 0.0,
        "marginBottom", 12.0,
        "marginLeft", 20.0,
        "itemSpacing", 4.0,
        "bulletColor", -16777216.0,
        "bulletSize", 6.0,
        "markerMinWidth", 0.0,
        "markerColor", -16777216.0,
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
    listOf(
      "paragraph",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
      "strikethrough",
      "underline",
      "link",
      "code",
      "blockquote",
      "list",
      "codeBlock",
      "thematicBreak",
      "image",
      "inlineImage",
      "video",
      "table",
      "taskList",
      "math",
      "inlineMath",
      "spoiler",
      "superscript",
      "subscript",
      "highlight",
    ).forEach { styles.putMap(it, base) }
    styles.putArray("linkVariants", JavaOnlyArray())
    return StyleConfig(styles, context, allowFontScaling = false, maxFontSizeMultiplier = 1f)
  }

  private fun measureTextView(
    text: CharSequence,
    fontSizePx: Float,
    widthPx: Int,
  ): EnrichedMarkdownInternalText {
    val context = RuntimeEnvironment.getApplication()
    return EnrichedMarkdownInternalText(context).apply {
      setTextSize(TypedValue.COMPLEX_UNIT_PX, fontSizePx)
      breakStrategy = Layout.BREAK_STRATEGY_HIGH_QUALITY
      applyStyledText(text)
      measure(
        MeasureSpec.makeMeasureSpec(widthPx, MeasureSpec.EXACTLY),
        MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
      )
    }
  }

  @Test
  fun listNestedBlockquotesMatchMeasurementAndKeepSpacerHeights() {
    val context = RuntimeEnvironment.getApplication()
    val style = styleConfig()
    val widthPx = 640
    val fontSizePx = style.paragraphStyle.fontSize

    val ast =
      MarkdownASTNode(
        NodeType.Document,
        children =
          listOf(
            MarkdownASTNode(
              NodeType.OrderedList,
              attributes = mapOf("start" to "1"),
              children =
                listOf(
                  MarkdownASTNode(
                    NodeType.ListItem,
                    children =
                      listOf(
                        MarkdownASTNode(NodeType.Paragraph, children = listOf(MarkdownASTNode(NodeType.Text, "First item"))),
                        MarkdownASTNode(
                          NodeType.Blockquote,
                          children =
                            listOf(
                              MarkdownASTNode(NodeType.Paragraph, children = listOf(MarkdownASTNode(NodeType.Text, "First quote"))),
                            ),
                        ),
                      ),
                  ),
                  MarkdownASTNode(
                    NodeType.ListItem,
                    children =
                      listOf(
                        MarkdownASTNode(NodeType.Paragraph, children = listOf(MarkdownASTNode(NodeType.Text, "Second item"))),
                        MarkdownASTNode(
                          NodeType.Blockquote,
                          children =
                            listOf(
                              MarkdownASTNode(NodeType.Paragraph, children = listOf(MarkdownASTNode(NodeType.Text, "Second quote"))),
                            ),
                        ),
                      ),
                  ),
                ),
            ),
            MarkdownASTNode(NodeType.Paragraph, children = listOf(MarkdownASTNode(NodeType.Text, "Trailing paragraph"))),
          ),
      )

    val renderer = Renderer().apply { configure(style, context) }
    val rendered = renderer.renderDocument(ast)

    val storeLayout = MeasurementStore.createStaticLayout(rendered, fontSizePx, widthPx, null)
    val segmentLayout =
      SegmentHeightMeasurer.createStaticLayout(rendered, fontSizePx, widthPx, Layout.BREAK_STRATEGY_HIGH_QUALITY)
    val textView = measureTextView(rendered, fontSizePx, widthPx)

    assertEquals("MeasurementStore and TextView must agree on height", textView.measuredHeight, storeLayout.height)
    assertEquals("SegmentHeightMeasurer and TextView must agree on height", textView.measuredHeight, segmentLayout.height)

    // Verify blockquote top-padding and bottom-margin spacer lines keep their configured
    // heights instead of being inflated to list.lineHeight (22dp).
    val paddingPx = style.blockquoteStyle.padding.toInt()
    val marginBottomPx = style.blockquoteStyle.marginBottom.toInt()
    val itemSpacingPx = style.listStyle.itemSpacing.toInt()
    val spacerLineHeights =
      (0 until storeLayout.lineCount)
        .filter { line ->
          val start = storeLayout.getLineStart(line)
          val end = storeLayout.getLineEnd(line)
          end - start == 1 && rendered[start] == '\n'
        }.map { line -> storeLayout.getLineBottom(line) - storeLayout.getLineTop(line) }

    assertEquals(
      listOf(paddingPx, marginBottomPx + itemSpacingPx, paddingPx, marginBottomPx, marginBottomPx),
      spacerLineHeights,
    )
  }

  @Test
  fun measurementStaticLayoutUsesInsertionOrderLikeTextView() {
    val context = RuntimeEnvironment.getApplication()
    DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(context)
    val widthPx = 400
    val fontSizePx = 16f

    // Inner priority-0 spacer inserted before outer priority-0 LineHeightSpan:
    // SpannableStringBuilder's unsorted fast path orders by start offset (outer first),
    // while InsertionOrderedSpannable orders by insertion order (inner first, so outer inflates it).
    val builder = SpannableStringBuilder("first\n\nsecond")
    builder.setSpan(
      object : AndroidLineHeightSpan {
        override fun chooseHeight(
          text: CharSequence,
          start: Int,
          end: Int,
          spanstartv: Int,
          v: Int,
          fm: Paint.FontMetricsInt,
        ) {
          fm.top = 0
          fm.ascent = 0
          fm.descent = 12
          fm.bottom = 12
        }
      },
      6,
      7,
      SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE,
    )
    builder.setSpan(LineHeightSpan(40f), 0, builder.length, SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE)

    val storeLayout = MeasurementStore.createStaticLayout(builder, fontSizePx, widthPx, null)
    val segmentLayout =
      SegmentHeightMeasurer.createStaticLayout(builder, fontSizePx, widthPx, Layout.BREAK_STRATEGY_HIGH_QUALITY)
    val textView = measureTextView(builder, fontSizePx, widthPx)

    assertEquals(textView.measuredHeight, storeLayout.height)
    assertEquals(textView.measuredHeight, segmentLayout.height)
  }
}
