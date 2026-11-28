package com.swmansion.enriched.markdown.styles

import android.content.Context
import com.facebook.react.bridge.ColorPropConverter
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.uimanager.PixelUtil

class StyleParser(
  private val context: Context,
  private val allowFontScaling: Boolean,
  private val maxFontSizeMultiplier: Float,
) {
  fun parseOptionalColor(
    map: ReadableMap,
    key: String,
  ): Int? {
    if (!map.hasKey(key) || map.isNull(key)) {
      return null
    }
    val colorValue = map.getDouble(key)
    return ColorPropConverter.getColor(colorValue, context)
  }

  fun parseColor(
    map: ReadableMap,
    key: String,
  ): Int =
    parseOptionalColor(map, key)
      ?: throw IllegalArgumentException("Color key '$key' is missing, null, or invalid")

  fun parseOptionalDouble(
    map: ReadableMap,
    key: String,
    default: Double = 0.0,
  ): Double =
    if (map.hasKey(key) && !map.isNull(key)) {
      map.getDouble(key)
    } else {
      default
    }

  fun parseOptionalInt(
    map: ReadableMap,
    key: String,
    default: Int = 0,
  ): Int =
    if (map.hasKey(key) && !map.isNull(key)) {
      map.getInt(key)
    } else {
      default
    }

  fun parseString(
    map: ReadableMap,
    key: String,
    default: String = "",
  ): String = map.getString(key) ?: default

  fun parseBoolean(
    map: ReadableMap,
    key: String,
    default: Boolean = false,
  ): Boolean =
    if (map.hasKey(key) && !map.isNull(key)) {
      map.getBoolean(key)
    } else {
      default
    }

  fun toPixelFromSP(value: Float): Float {
    val metrics = context.resources.displayMetrics
    val baseDensity = metrics.density

    if (!allowFontScaling) {
      return value * baseDensity
    }

    var fontScale = metrics.scaledDensity / baseDensity
    if (maxFontSizeMultiplier >= 1.0f && fontScale > maxFontSizeMultiplier) {
      fontScale = maxFontSizeMultiplier
    }

    return value * baseDensity * fontScale
  }

  fun toPixelFromDIP(value: Float): Float = PixelUtil.toPixelFromDIP(value)

  fun parseTextAlign(
    map: ReadableMap,
    key: String,
  ): TextAlignment = TextAlignment.fromString(parseString(map, key, "left"))
}
