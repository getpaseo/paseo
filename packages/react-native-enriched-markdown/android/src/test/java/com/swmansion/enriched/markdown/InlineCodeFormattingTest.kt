package com.swmansion.enriched.markdown

import android.text.TextPaint
import com.facebook.react.bridge.JavaOnlyMap
import com.swmansion.enriched.markdown.renderer.BlockStyle
import com.swmansion.enriched.markdown.renderer.SpanStyleCache
import com.swmansion.enriched.markdown.spans.CodeSpan
import com.swmansion.enriched.markdown.spans.StrongSpan
import com.swmansion.enriched.markdown.spans.EmphasisSpan
import com.swmansion.enriched.markdown.styles.StyleConfig
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
@Config(manifest = Config.NONE, sdk = [34])
class InlineCodeFormattingTest {
  private fun cache(): SpanStyleCache {
    com.facebook.react.uimanager.DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(RuntimeEnvironment.getApplication())
    val common = JavaOnlyMap.of(
      "fontFamily", "", "fontWeight", "bold", "fontStyle", "italic",
      "fontSize", 12.0, "color", -16777216.0, "backgroundColor", 0.0,
      "borderColor", 0.0, "underline", false,
      "marginTop", 0.0, "marginBottom", 0.0, "lineHeight", 20.0, "textAlign", "left",
      "checkedColor", 0.0, "checkmarkColor", 0.0, "checkedTextColor", 0.0,
      "checkboxSize", 18.0, "checkboxBorderRadius", 2.0, "checkedStrikethrough", false,
      "particles", JavaOnlyMap.of("density", 1.0, "speed", 1.0),
      "solid", JavaOnlyMap.of("borderRadius", 0.0),
      "fontScale", 0.7, "baselineOffsetScale", 0.3,
    )
    val styles = JavaOnlyMap()
    listOf("paragraph", "strong", "em", "strikethrough", "link", "code", "taskList",
      "spoiler", "superscript", "subscript", "highlight").forEach { styles.putMap(it, common) }
    styles.putMap("code", JavaOnlyMap.of("fontFamily", "", "fontSize", 0.0, "fontScale", 0.75, "color", -16777216.0, "backgroundColor", 0.0, "borderColor", 0.0))
    return SpanStyleCache(StyleConfig(styles, RuntimeEnvironment.getApplication(), false, 1f))
  }

  @Test fun boldPreservesInlineCodeSizeInMeasurementAndDrawing() {
    val cache = cache()
    for (blockSize in listOf(16f, 28f)) {
      val block = BlockStyle(blockSize, "", "normal", -16777216)
      for (draw in listOf(false, true)) {
        for (boldFirst in listOf(false, true)) {
          val paint = TextPaint().apply { textSize = blockSize }
          val code = CodeSpan(cache, block)
          val bold = StrongSpan(cache, block)
          val spans = if (boldFirst) listOf(bold, code) else listOf(code, bold)
          spans.forEach { if (draw) it.updateDrawState(paint) else it.updateMeasureState(paint) }
          assertEquals("Inline code size must survive bold in either span order", blockSize * 0.75f, paint.textSize, 0f)
          assertTrue(paint.typeface.isBold)
        }
      }
    }
  }

  @Test fun boldPreservesExistingSizeAndItalic() {
    val cache = cache()
    val block = BlockStyle(28f, "", "normal", -16777216)
    val paint = TextPaint().apply { textSize = 16f }
    EmphasisSpan(cache, block).updateMeasureState(paint)
    StrongSpan(cache, block).updateMeasureState(paint)
    assertEquals(16f, paint.textSize, 0f)
    assertTrue(paint.typeface.isBold)
    assertTrue(paint.typeface.isItalic)
  }

  @Test fun linksPreserveCodeAndEmphasizedProseFonts() {
    val cache = cache()
    val block = BlockStyle(28f, "", "normal", -16777216)
    for (code in listOf(false, true)) {
      val paint = TextPaint().apply { textSize = 16f }
      if (code) CodeSpan(cache, block).updateDrawState(paint)
      EmphasisSpan(cache, block).updateDrawState(paint)
      StrongSpan(cache, block).updateDrawState(paint)
      val size = paint.textSize
      val font = paint.typeface
      com.swmansion.enriched.markdown.spans.LinkSpan(
        "https://example.com", null, null, cache, block, RuntimeEnvironment.getApplication(),
      ).updateDrawState(paint)
      assertEquals(size, paint.textSize, 0f)
      assertEquals(font, paint.typeface)
    }
  }

}
