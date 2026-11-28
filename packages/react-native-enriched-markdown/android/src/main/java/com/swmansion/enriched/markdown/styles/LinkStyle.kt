package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class LinkStyle(
  val fontFamily: String,
  val color: Int,
  val underline: Boolean,
  val backgroundColor: Int,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): LinkStyle {
      val fontFamily = parser.parseString(map, "fontFamily")
      val color = parser.parseColor(map, "color")
      val underline = map.getBoolean("underline")
      val backgroundColor = parser.parseColor(map, "backgroundColor")
      return LinkStyle(fontFamily, color, underline, backgroundColor)
    }
  }
}
