package com.swmansion.enriched.markdown.test

import android.content.Context
import android.graphics.Color
import android.text.Spannable
import com.facebook.react.bridge.JavaOnlyArray
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.renderer.Renderer
import com.swmansion.enriched.markdown.styles.StyleConfig
import org.robolectric.RuntimeEnvironment

object MarkdownRenderTestSupport {
  // Resolved per call, not cached: a @Config qualifier applies to the current test's context.
  private val context: Context
    get() = RuntimeEnvironment.getApplication()

  fun render(
    style: StyleConfig,
    vararg blocks: MarkdownASTNode,
  ): Spannable {
    val renderer = Renderer()
    renderer.configure(style, context)
    return renderer.renderContent(blocks.toList())
  }

  /**
   * The style map the JS side sends, with [list] and [taskList] entries replacing the defaults.
   * Sizes are Double, colors Int, as in a ReadableMap.
   */
  fun styleConfig(
    list: Map<String, Any> = emptyMap(),
    taskList: Map<String, Any> = emptyMap(),
  ): StyleConfig {
    DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(context)
    val style = JavaOnlyMap()
    listOf("paragraph", "strong", "em", "strikethrough", "code", "superscript", "subscript", "highlight")
      .forEach { style.putMap(it, textElement()) }
    style.putMap("link", textElement().apply { putString("fontFamily", "serif") })
    style.putArray(
      "linkVariants",
      JavaOnlyArray.of(
        textElement().apply {
          putString("pattern", "^ref:")
          putString("fontFamily", "monospace")
          putInt("color", Color.BLUE)
        },
      ),
    )
    style.putMap(
      "spoiler",
      textElement().apply {
        putMap("particles", JavaOnlyMap.of("density", 0.5, "speed", 1.0))
        putMap("solid", JavaOnlyMap.of("borderRadius", 0.0))
      },
    )
    style.putMap("taskList", JavaOnlyMap().apply { putAll(defaultTaskList + taskList) })
    style.putMap("list", textElement().apply { putAll(defaultList + list) })
    return StyleConfig(style, context, false, 0f)
  }

  private val defaultList: Map<String, Any> =
    mapOf(
      "fontFamily" to "",
      "bulletColor" to Color.BLACK,
      "markerColor" to Color.BLACK,
      "bulletSize" to 6.0,
      "markerMinWidth" to 0.0,
      "gapWidth" to 8.0,
      "marginLeft" to 24.0,
      "itemSpacing" to 0.0,
    )

  private val defaultTaskList: Map<String, Any> =
    mapOf(
      "checkedColor" to Color.BLACK,
      "borderColor" to Color.BLACK,
      "checkmarkColor" to Color.BLACK,
      "checkedTextColor" to Color.BLACK,
      "checkboxSize" to 16.0,
      "checkboxBorderRadius" to 0.0,
      "checkedStrikethrough" to false,
    )

  private fun textElement(): JavaOnlyMap =
    JavaOnlyMap.of(
      "fontFamily",
      "",
      "fontWeight",
      "normal",
      "fontSize",
      16.0,
      "lineHeight",
      0.0,
      "marginTop",
      0.0,
      "marginBottom",
      0.0,
      "color",
      Color.BLACK,
      "backgroundColor",
      Color.TRANSPARENT,
      "borderColor",
      Color.TRANSPARENT,
      "underline",
      false,
      "fontScale",
      0.8,
      "baselineOffsetScale",
      0.5,
    )

  private fun JavaOnlyMap.putAll(values: Map<String, Any>) {
    for ((key, value) in values) {
      when (value) {
        is String -> putString(key, value)
        is Boolean -> putBoolean(key, value)
        is Int -> putInt(key, value)
        is Double -> putDouble(key, value)
        is Float -> putDouble(key, value.toDouble())
        else -> error("Unsupported style value for $key: $value")
      }
    }
  }
}
