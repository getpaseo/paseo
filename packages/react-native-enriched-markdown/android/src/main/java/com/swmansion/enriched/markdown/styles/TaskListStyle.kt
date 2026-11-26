package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

data class TaskListStyle(
  val checkedColor: Int,
  val borderColor: Int,
  val checkboxSize: Float,
  val checkboxBorderRadius: Float,
  val checkmarkColor: Int,
  val checkedTextColor: Int,
  val checkedStrikethrough: Boolean,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): TaskListStyle =
      TaskListStyle(
        checkedColor = parser.parseColor(map, "checkedColor"),
        borderColor = parser.parseColor(map, "borderColor"),
        checkboxSize = parser.toPixelFromDIP(map.getDouble("checkboxSize").toFloat()),
        checkboxBorderRadius = parser.toPixelFromDIP(map.getDouble("checkboxBorderRadius").toFloat()),
        checkmarkColor = parser.parseColor(map, "checkmarkColor"),
        checkedTextColor = parser.parseColor(map, "checkedTextColor"),
        checkedStrikethrough = map.getBoolean("checkedStrikethrough"),
      )
  }
}
