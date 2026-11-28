package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class StrikethroughStyle(
  val color: Int,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): StrikethroughStyle {
      val color = parser.parseColor(map, "color")
      return StrikethroughStyle(color)
    }
  }
}
