package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class SpoilerStyle(
  val color: Int,
  val particleDensity: Float,
  val particleSpeed: Float,
  val solidBorderRadius: Float,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): SpoilerStyle {
      val color = parser.parseColor(map, "color")
      val particlesMap = map.getMap("particles")!!
      val solidMap = map.getMap("solid")!!
      return SpoilerStyle(
        color = color,
        particleDensity = particlesMap.getDouble("density").toFloat(),
        particleSpeed = particlesMap.getDouble("speed").toFloat(),
        solidBorderRadius = solidMap.getDouble("borderRadius").toFloat(),
      )
    }
  }
}
