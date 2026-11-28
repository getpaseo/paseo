package com.swmansion.enriched.markdown.input.editing

import com.swmansion.enriched.markdown.input.model.StyleType

/**
 * Immutable snapshot of everything the [EditPipeline] needs to process a single
 * text change. Built by the view from its pre-/post-edit state, then handed to
 * [EditPipeline.processTextChange].
 */
data class EditContext(
  val editStart: Int,
  val deletedLength: Int,
  val insertedLength: Int,
  val preEditText: String,
  val preEditSelectionStart: Int,
  val preEditSelectionEnd: Int,
  val pendingStyles: Set<StyleType>,
  val pendingStyleRemovals: Set<StyleType>,
)
