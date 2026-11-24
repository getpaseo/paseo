package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class VideoStyle(
  val marginTop: Float,
  val marginBottom: Float,
  val borderRadius: Float,
  val aspectRatio: Float,
  val backgroundColor: Int,
) {
  /** Aspect ratio guaranteed to be positive. Falls back to 16:9 if the raw value is ≤ 0. */
  val resolvedAspectRatio: Float
    get() = if (aspectRatio > 0f) aspectRatio else DEFAULT_ASPECT_RATIO

  companion object {
    private const val DEFAULT_ASPECT_RATIO = 16f / 9f

    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): VideoStyle {
      val marginTop = parser.toPixelFromDIP(map.getDouble("marginTop").toFloat())
      val marginBottom = parser.toPixelFromDIP(map.getDouble("marginBottom").toFloat())
      val borderRadius = parser.toPixelFromDIP(map.getDouble("borderRadius").toFloat())
      val aspectRatio = map.getDouble("aspectRatio").toFloat()
      val backgroundColor = parser.parseColor(map, "backgroundColor")
      return VideoStyle(marginTop, marginBottom, borderRadius, aspectRatio, backgroundColor)
    }
  }
}
