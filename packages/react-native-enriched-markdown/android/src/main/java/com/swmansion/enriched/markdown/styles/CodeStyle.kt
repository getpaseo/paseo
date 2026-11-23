package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class CodeStyle(
  val fontFamily: String,
  val fontSize: Float,
  val fontScale: Float,
  val color: Int,
  val backgroundColor: Int,
  val borderColor: Int,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): CodeStyle {
      val fontFamily = parser.parseString(map, "fontFamily")
      val fontSizeRaw = parser.parseOptionalDouble(map, "fontSize").toFloat()
      val fontSize = if (fontSizeRaw > 0) parser.toPixelFromSP(fontSizeRaw) else 0f
      val fontScale = parser.parseOptionalDouble(map, "fontScale", 1.0).toFloat()
      val color = parser.parseColor(map, "color")
      val backgroundColor = parser.parseColor(map, "backgroundColor")
      val borderColor = parser.parseColor(map, "borderColor")
      return CodeStyle(fontFamily, fontSize, fontScale, color, backgroundColor, borderColor)
    }
  }
}
