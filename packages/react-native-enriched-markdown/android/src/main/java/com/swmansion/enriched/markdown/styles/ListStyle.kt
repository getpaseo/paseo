package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class ListStyle(
  override val fontSize: Float,
  override val fontFamily: String,
  override val fontWeight: String,
  override val color: Int,
  override val marginTop: Float,
  override val marginBottom: Float,
  override val lineHeight: Float,
  val bulletColor: Int,
  val bulletSize: Float,
  val markerMinWidth: Float,
  val markerColor: Int,
  val markerFontWeight: String,
  val gapWidth: Float,
  val marginLeft: Float,
  val itemSpacing: Float,
) : BaseBlockStyle {
  fun effectiveMarkerWidth(naturalWidth: Float): Float = naturalWidth.coerceAtLeast(markerMinWidth)

  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): ListStyle {
      val fontSize = parser.toPixelFromSP(map.getDouble("fontSize").toFloat())
      val fontFamily = parser.parseString(map, "fontFamily")
      val fontWeight = parser.parseString(map, "fontWeight", "normal")
      val color = parser.parseColor(map, "color")
      val marginTop = parser.toPixelFromDIP(map.getDouble("marginTop").toFloat())
      val marginBottom = parser.toPixelFromDIP(map.getDouble("marginBottom").toFloat())
      val lineHeightRaw = map.getDouble("lineHeight").toFloat()
      val lineHeight = parser.toPixelFromSP(lineHeightRaw)
      val bulletColor = parser.parseColor(map, "bulletColor")
      val bulletSize = parser.toPixelFromSP(map.getDouble("bulletSize").toFloat())
      val markerMinWidth = parser.toPixelFromDIP(map.getDouble("markerMinWidth").toFloat().coerceAtLeast(0f))
      val markerColor = parser.parseColor(map, "markerColor")
      val markerFontWeight = parser.parseString(map, "markerFontWeight", "normal")
      val gapWidth = parser.toPixelFromDIP(map.getDouble("gapWidth").toFloat())
      val marginLeft = parser.toPixelFromDIP(map.getDouble("marginLeft").toFloat())
      val itemSpacing = parser.toPixelFromDIP(map.getDouble("itemSpacing").toFloat().coerceAtLeast(0f))

      return ListStyle(
        fontSize,
        fontFamily,
        fontWeight,
        color,
        marginTop,
        marginBottom,
        lineHeight,
        bulletColor,
        bulletSize,
        markerMinWidth,
        markerColor,
        markerFontWeight,
        gapWidth,
        marginLeft,
        itemSpacing,
      )
    }
  }
}
