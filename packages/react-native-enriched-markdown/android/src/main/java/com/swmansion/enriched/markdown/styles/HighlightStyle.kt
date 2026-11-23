package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class HighlightStyle(
  val color: Int,
  val backgroundColor: Int,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): HighlightStyle {
      val color = parser.parseColor(map, "color")
      val backgroundColor = parser.parseColor(map, "backgroundColor")
      return HighlightStyle(color, backgroundColor)
    }
  }
}
