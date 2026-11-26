package com.swmansion.enriched.markdown.spans

enum class MathRenderMode {
  Text,
  Display,
}

data class MathMeasureRequest(
  val fontSize: Float,
  val latex: String,
  val mode: MathRenderMode = MathRenderMode.Text,
)

data class MathMetrics(
  val width: Int,
  val ascent: Float,
  val descent: Float,
)
