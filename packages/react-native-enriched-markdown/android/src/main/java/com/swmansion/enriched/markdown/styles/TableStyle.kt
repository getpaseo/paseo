package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class TableStyle(
  override val fontSize: Float,
  override val fontFamily: String,
  override val fontWeight: String,
  override val color: Int,
  override val marginTop: Float,
  override val marginBottom: Float,
  override val lineHeight: Float,
  val headerFontFamily: String,
  val headerBackgroundColor: Int,
  val headerTextColor: Int,
  val rowEvenBackgroundColor: Int,
  val rowOddBackgroundColor: Int,
  val borderColor: Int,
  val borderWidth: Float,
  val borderRadius: Float,
  val cellPaddingHorizontal: Float,
  val cellPaddingVertical: Float,
  val horizontalOverflow: Float,
  val align: String,
) : BaseBlockStyle {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): TableStyle {
      val fontSize = parser.toPixelFromSP(map.getDouble("fontSize").toFloat())
      val fontFamily = parser.parseString(map, "fontFamily")
      val fontWeight = parser.parseString(map, "fontWeight", "normal")
      val color = parser.parseColor(map, "color")
      val marginTop = parser.toPixelFromDIP(map.getDouble("marginTop").toFloat())
      val marginBottom = parser.toPixelFromDIP(map.getDouble("marginBottom").toFloat())
      val lineHeightRaw = map.getDouble("lineHeight").toFloat()
      val lineHeight = if (lineHeightRaw > 0f) parser.toPixelFromSP(lineHeightRaw) else 0f
      val headerFontFamily = parser.parseString(map, "headerFontFamily")
      val headerBackgroundColor = parser.parseColor(map, "headerBackgroundColor")
      val headerTextColor = parser.parseColor(map, "headerTextColor")
      val rowEvenBackgroundColor = parser.parseColor(map, "rowEvenBackgroundColor")
      val rowOddBackgroundColor = parser.parseColor(map, "rowOddBackgroundColor")
      val borderColor = parser.parseColor(map, "borderColor")
      val borderWidth = parser.toPixelFromDIP(map.getDouble("borderWidth").toFloat())
      val borderRadius = parser.toPixelFromDIP(map.getDouble("borderRadius").toFloat())
      val cellPaddingHorizontal = parser.toPixelFromDIP(map.getDouble("cellPaddingHorizontal").toFloat())
      val cellPaddingVertical = parser.toPixelFromDIP(map.getDouble("cellPaddingVertical").toFloat())
      val horizontalOverflow = parser.toPixelFromDIP(map.getDouble("horizontalOverflow").toFloat())
      val align = parser.parseString(map, "align")

      return TableStyle(
        fontSize = fontSize,
        fontFamily = fontFamily,
        fontWeight = fontWeight,
        color = color,
        marginTop = marginTop,
        marginBottom = marginBottom,
        lineHeight = lineHeight,
        headerFontFamily = headerFontFamily,
        headerBackgroundColor = headerBackgroundColor,
        headerTextColor = headerTextColor,
        rowEvenBackgroundColor = rowEvenBackgroundColor,
        rowOddBackgroundColor = rowOddBackgroundColor,
        borderColor = borderColor,
        borderWidth = borderWidth,
        borderRadius = borderRadius,
        cellPaddingHorizontal = cellPaddingHorizontal,
        cellPaddingVertical = cellPaddingVertical,
        horizontalOverflow = horizontalOverflow,
        align = align,
      )
    }
  }
}
