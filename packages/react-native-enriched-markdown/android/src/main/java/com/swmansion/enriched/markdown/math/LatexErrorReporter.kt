package com.swmansion.enriched.markdown.math

fun interface LatexErrorReporter {
  fun report(
    source: String,
    message: String?,
    displayMode: Boolean,
  )
}
