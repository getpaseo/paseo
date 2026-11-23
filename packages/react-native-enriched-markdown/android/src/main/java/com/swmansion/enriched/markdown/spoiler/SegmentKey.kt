package com.swmansion.enriched.markdown.spoiler

data class SegmentKey(
  val spanIdentity: Int,
  val line: Int,
)

data class SegmentRect(
  val left: Float,
  val top: Float,
  val width: Float,
  val height: Float,
)
