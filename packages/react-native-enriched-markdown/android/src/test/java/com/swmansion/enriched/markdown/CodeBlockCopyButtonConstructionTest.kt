package com.swmansion.enriched.markdown

import android.content.Context
import android.graphics.Color
import android.util.AttributeSet
import android.view.ContextThemeWrapper
import android.view.accessibility.AccessibilityEvent
import android.widget.ImageButton
import com.facebook.react.bridge.JavaOnlyArray
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.swmansion.enriched.markdown.accessibility.AccessibilityLabels
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.parser.MarkdownASTNode.NodeType
import com.swmansion.enriched.markdown.segments.BlockquoteContainerView
import com.swmansion.enriched.markdown.segments.CodeBlockContainerView
import com.swmansion.enriched.markdown.segments.DynamicBlockProps
import com.swmansion.enriched.markdown.segments.SegmentViewConfig
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.test.TestAstFactory.paragraph
import com.swmansion.enriched.markdown.test.TestAstFactory.text
import com.swmansion.enriched.markdown.utils.text.view.SelectionMenuConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowView

/**
 * Some Android builds read a button's content description while `ImageButton`
 * is still being constructed. Samsung One UI does this from
 * `semSetHoverPopupType`, before the copy button's own fields are assigned.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [34], shadows = [CodeBlockCopyButtonConstructionTest.ReadsDescriptionInConstructor::class])
class CodeBlockCopyButtonConstructionTest {
  private val context: Context =
    ContextThemeWrapper(RuntimeEnvironment.getApplication(), androidx.appcompat.R.style.Theme_AppCompat)

  /** Reads the content description while the view is still being constructed. */
  @Implements(ImageButton::class)
  class ReadsDescriptionInConstructor : ShadowView() {
    @Implementation
    override fun __constructor__(
      context: Context,
      attrs: AttributeSet?,
      defStyleAttr: Int,
      defStyleRes: Int,
    ) {
      super.__constructor__(context, attrs, defStyleAttr, defStyleRes)
      reads++
      realView.contentDescription
    }

    companion object {
      var reads = 0
    }
  }

  @Before fun resetReads() {
    ReadsDescriptionInConstructor.reads = 0
  }

  private fun styleConfig(): StyleConfig {
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
      )
    val styles = JavaOnlyMap()
    ELEMENTS.forEach { styles.putMap(it, element) }
    styles.putArray("linkVariants", JavaOnlyArray())
    return StyleConfig(styles, context, false, 1f)
  }

  private fun segmentViewConfig(dynamicProps: DynamicBlockProps): SegmentViewConfig =
    SegmentViewConfig(
      context = context,
      style = styleConfig(),
      allowFontScaling = false,
      maxFontSizeMultiplier = 1f,
      accessibilityLabels = AccessibilityLabels(),
      selectionMenuConfig = SelectionMenuConfig(),
      textBreakStrategy = "simple",
      selectable = true,
      selectionColor = null,
      selectionHandleColor = null,
      contextMenuItemTexts = emptyList(),
      dynamicProps = dynamicProps,
      onLinkPress = null,
      onLinkLongPress = null,
      onTaskListItemPress = null,
      onContextMenuItemPress = null,
    )

  private fun CodeBlockContainerView.copyButton(): ImageButton =
    (0 until childCount).map { getChildAt(it) }.filterIsInstance<ImageButton>().single()

  private fun BlockquoteContainerView.copyButton(): ImageButton =
    (0 until childCount).map { getChildAt(it) }.filterIsInstance<ImageButton>().single()

  private fun ImageButton.accessibilityEventDescription(): CharSequence? {
    val event = AccessibilityEvent()
    onInitializeAccessibilityEvent(event)
    return event.contentDescription
  }

  @Test fun codeBlockOpensWhenTheButtonReadsItsDescriptionDuringConstruction() {
    val view = CodeBlockContainerView(context, styleConfig())
    assertTrue("Expected ImageButton constructor shadow to read contentDescription", ReadsDescriptionInConstructor.reads > 0)
    view.dynamicProps = DynamicBlockProps().apply { copyLabel = "Copy code" }

    val button = view.copyButton()
    assertEquals("Copy code", button.contentDescription)
    assertEquals("Copy code", button.accessibilityEventDescription())

    view.dynamicProps.copyLabel = "Copier"
    view.syncCopyLabel()
    assertEquals("Copier", button.contentDescription)
    assertEquals("Copier", button.accessibilityEventDescription())
  }

  @Test fun blockquoteAndNestedBlocksOpenAndSyncCopyLabelsDuringConstruction() {
    val dynamicProps = DynamicBlockProps().apply { copyLabel = "Copy" }
    val quote = BlockquoteContainerView(context, segmentViewConfig(dynamicProps))
    assertTrue("Expected ImageButton constructor shadow to read contentDescription", ReadsDescriptionInConstructor.reads > 0)
    quote.applyBlockquoteNode(
      MarkdownASTNode(
        NodeType.Blockquote,
        children =
          listOf(
            paragraph(text("Outer")),
            MarkdownASTNode(
              NodeType.Blockquote,
              children = listOf(paragraph(text("Inner"))),
            ),
            MarkdownASTNode(
              NodeType.CodeBlock,
              attributes = mapOf("language" to "kt", "fenceChar" to "`"),
              children = listOf(text("val x = 1")),
            ),
          ),
      ),
    )

    val nestedQuote = (0 until quote.childCount).map { quote.getChildAt(it) }.filterIsInstance<BlockquoteContainerView>().single()
    val nestedCode = (0 until quote.childCount).map { quote.getChildAt(it) }.filterIsInstance<CodeBlockContainerView>().single()

    assertEquals("Copy", quote.copyButton().contentDescription)
    assertEquals("Copy", quote.copyButton().accessibilityEventDescription())
    assertEquals("Copy", nestedQuote.copyButton().contentDescription)
    assertEquals("Copy", nestedCode.copyButton().contentDescription)

    dynamicProps.copyLabel = "Copy snippet"
    quote.syncCopyLabel()

    assertEquals("Copy snippet", quote.copyButton().contentDescription)
    assertEquals("Copy snippet", nestedQuote.copyButton().contentDescription)
    assertEquals("Copy snippet", nestedCode.copyButton().contentDescription)
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
