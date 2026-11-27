package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class UnderlineStyle(
  val color: Int,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): UnderlineStyle {
      val color = parser.parseColor(map, "color")
      return UnderlineStyle(color)
    }
  }
}
