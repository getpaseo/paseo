package com.swmansion.enriched.markdown.accessibility

data class AccessibilityLabels(
  val bulletPoint: String = "",
  val nestedBulletPoint: String = "",
  val orderedItem: String = "",
  val nestedOrderedItem: String = "",
  val blockquote: String = "",
  val nestedBlockquote: String = "",
  val tableRow: String = "",
  val mathEquation: String = "",
  val rotorHeadings: String = "",
  val rotorLinks: String = "",
  val rotorImages: String = "",
)
