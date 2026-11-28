package com.swmansion.enriched.markdown.input.model

import com.facebook.react.bridge.WritableMap

data class CaretRect(
  val x: Float,
  val y: Float,
  val width: Float,
  val height: Float,
) {
  fun putInto(map: WritableMap) {
    map.putDouble("x", x.toDouble())
    map.putDouble("y", y.toDouble())
    map.putDouble("width", width.toDouble())
    map.putDouble("height", height.toDouble())
  }
}
