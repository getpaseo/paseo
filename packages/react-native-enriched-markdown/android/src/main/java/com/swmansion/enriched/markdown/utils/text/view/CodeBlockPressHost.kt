package com.swmansion.enriched.markdown.utils.text.view

/**
 * Implemented by the commonmark host view so [LinkLongPressMovementMethod] can
 * gate and dispatch taps landing on a code block span. GFM uses a separate
 * CodeBlockContainerView, so its host walk resolves to none.
 */
interface CodeBlockPressHost {
  val codeBlockPressEnabled: Boolean

  fun emitOnCodeBlockPress(
    code: String,
    language: String,
  )
}
