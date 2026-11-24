package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class MathStyle(
  val fontSize: Float,
  val color: Int,
  val backgroundColor: Int,
  val padding: Float,
  val marginTop: Float,
  val marginBottom: Float,
  val textAlign: String,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): MathStyle {
      val fontSize = parser.toPixelFromSP(map.getDouble("fontSize").toFloat())
      val color = parser.parseColor(map, "color")
      val backgroundColor = parser.parseColor(map, "backgroundColor")
      val padding = parser.toPixelFromDIP(map.getDouble("padding").toFloat())
      val marginTop = parser.toPixelFromDIP(map.getDouble("marginTop").toFloat())
      val marginBottom = parser.toPixelFromDIP(map.getDouble("marginBottom").toFloat())
      val textAlign = parser.parseString(map, "textAlign", "center")
      return MathStyle(fontSize, color, backgroundColor, padding, marginTop, marginBottom, textAlign)
    }
  }
}
