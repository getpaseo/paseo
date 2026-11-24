package com.swmansion.enriched.markdown.input.detection

data class WordResult(
  val word: String,
  val start: Int,
  val end: Int,
)
