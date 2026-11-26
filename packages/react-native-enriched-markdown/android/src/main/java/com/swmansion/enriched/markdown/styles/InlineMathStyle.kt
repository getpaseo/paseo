package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class InlineMathStyle(
  val color: Int,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): InlineMathStyle {
      val color = parser.parseColor(map, "color")
      return InlineMathStyle(color)
    }
  }
}
