package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class StrongStyle(
  val fontFamily: String,
  val fontWeight: String,
  val color: Int?,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): StrongStyle {
      val fontFamily = parser.parseString(map, "fontFamily")
      val fontWeight = parser.parseString(map, "fontWeight")
      val color = parser.parseOptionalColor(map, "color")
      return StrongStyle(fontFamily, fontWeight, color)
    }
  }
}
