package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class CodeBlockStyle(
  override val fontSize: Float,
  override val fontFamily: String,
  override val fontWeight: String,
  override val color: Int,
  override val marginTop: Float,
  override val marginBottom: Float,
  override val lineHeight: Float,
  val backgroundColor: Int,
  val borderColor: Int,
  val borderRadius: Float,
  val borderWidth: Float,
  val padding: Float,
  val syntaxColors: List<Int>,
) : BaseBlockStyle {
  companion object {
    private val SYNTAX_COLOR_KEYS =
      listOf(
        "keyword",
        "operatorColor",
        "punctuation",
        "string",
        "number",
        "constant",
        "comment",
        "function",
        "type",
        "variable",
        "property",
        "tag",
        "attribute",
        "embedded",
      )

    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): CodeBlockStyle {
      val fontSize = parser.toPixelFromSP(map.getDouble("fontSize").toFloat())
      val fontFamily = parser.parseString(map, "fontFamily")
      val fontWeight = parser.parseString(map, "fontWeight", "normal")
      val color = parser.parseColor(map, "color")
      val marginTop = parser.toPixelFromDIP(map.getDouble("marginTop").toFloat())
      val marginBottom = parser.toPixelFromDIP(map.getDouble("marginBottom").toFloat())
      val lineHeightRaw = map.getDouble("lineHeight").toFloat()
      val lineHeight = parser.toPixelFromSP(lineHeightRaw)
      val backgroundColor = parser.parseColor(map, "backgroundColor")
      val borderColor = parser.parseColor(map, "borderColor")
      val borderRadius = parser.toPixelFromDIP(map.getDouble("borderRadius").toFloat())
      val borderWidth = parser.toPixelFromDIP(map.getDouble("borderWidth").toFloat())
      val padding = parser.toPixelFromDIP(map.getDouble("padding").toFloat())

      val syntaxMap = map.getMap("syntaxColors")
      val syntaxColors =
        SYNTAX_COLOR_KEYS.map { key ->
          syntaxMap?.let { parser.parseOptionalColor(it, key) } ?: color
        }

      return CodeBlockStyle(
        fontSize,
        fontFamily,
        fontWeight,
        color,
        marginTop,
        marginBottom,
        lineHeight,
        backgroundColor,
        borderColor,
        borderRadius,
        borderWidth,
        padding,
        syntaxColors,
      )
    }
  }
}
