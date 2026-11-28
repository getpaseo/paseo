package com.swmansion.enriched.markdown.input.styles

import com.swmansion.enriched.markdown.input.model.StyleType

// conflictingStyles: removed from the range when this style is applied.
// blockingStyles: prevent this style from being toggled on when active.
data class StyleMergingConfig(
  val conflictingStyles: Set<StyleType> = emptySet(),
  val blockingStyles: Set<StyleType> = emptySet(),
)
