package com.swmansion.enriched.markdown.utils.text.view

/**
 * Implemented by the React-tagged host views (EnrichedMarkdownText and the GFM
 * EnrichedMarkdown container) so [LinkLongPressMovementMethod] can gate and
 * dispatch image taps without knowing which flavor owns the tapped TextView.
 *
 * In GFM the tapped TextView is an internal segment child, so the movement
 * method walks up to the nearest host - the same routing ImageSpan uses for its
 * box-height notifications.
 */
interface ImagePressHost {
  val imagePressEnabled: Boolean

  fun emitOnImagePress(
    url: String,
    altText: String,
  )
}
