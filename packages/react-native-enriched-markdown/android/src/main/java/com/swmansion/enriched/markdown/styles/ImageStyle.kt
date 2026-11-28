package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class ImageStyle(
  val height: Float,
  val maxHeight: Float,
  val aspectRatio: Float,
  val resizeMode: String,
  val borderRadius: Float,
  val marginTop: Float,
  val marginBottom: Float,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): ImageStyle {
      val height = parser.toPixelFromDIP(map.getDouble("height").toFloat())
      val maxHeight = parser.toPixelFromDIP(map.getDouble("maxHeight").toFloat())
      val aspectRatio = map.getDouble("aspectRatio").toFloat()
      val resizeMode = map.getString("resizeMode") ?: ""
      val borderRadius = parser.toPixelFromDIP(map.getDouble("borderRadius").toFloat())
      val marginTop = parser.toPixelFromDIP(map.getDouble("marginTop").toFloat())
      val marginBottom = parser.toPixelFromDIP(map.getDouble("marginBottom").toFloat())
      return ImageStyle(height, maxHeight, aspectRatio, resizeMode, borderRadius, marginTop, marginBottom)
    }
  }
}
