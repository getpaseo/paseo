package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class ThematicBreakStyle(
  val color: Int,
  val height: Float,
  val marginTop: Float,
  val marginBottom: Float,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): ThematicBreakStyle {
      val color = parser.parseColor(map, "color")
      val height = parser.toPixelFromDIP(map.getDouble("height").toFloat())
      val marginTop = parser.toPixelFromDIP(map.getDouble("marginTop").toFloat())
      val marginBottom = parser.toPixelFromDIP(map.getDouble("marginBottom").toFloat())
      return ThematicBreakStyle(color, height, marginTop, marginBottom)
    }
  }
}
