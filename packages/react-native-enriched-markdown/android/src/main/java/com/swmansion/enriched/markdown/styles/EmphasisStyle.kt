package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class EmphasisStyle(
  val fontFamily: String,
  val fontStyle: String,
  val color: Int?,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): EmphasisStyle {
      val fontFamily = parser.parseString(map, "fontFamily")
      val fontStyle = parser.parseString(map, "fontStyle")
      val color = parser.parseOptionalColor(map, "color")
      return EmphasisStyle(fontFamily, fontStyle, color)
    }
  }
}
