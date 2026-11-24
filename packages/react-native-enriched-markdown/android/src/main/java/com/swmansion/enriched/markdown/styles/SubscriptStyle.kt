package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class SubscriptStyle(
  val fontScale: Float,
  val baselineOffsetScale: Float,
) {
  companion object {
    fun fromReadableMap(map: ReadableMap): SubscriptStyle =
      SubscriptStyle(
        fontScale = map.getDouble("fontScale").toFloat(),
        baselineOffsetScale = map.getDouble("baselineOffsetScale").toFloat(),
      )
  }
}
