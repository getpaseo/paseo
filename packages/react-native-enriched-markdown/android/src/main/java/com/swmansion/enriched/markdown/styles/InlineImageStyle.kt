package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class InlineImageStyle(
  val size: Float,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): InlineImageStyle {
      val size = parser.toPixelFromDIP(map.getDouble("size").toFloat())
      return InlineImageStyle(size)
    }
  }
}
