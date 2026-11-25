package com.swmansion.enriched.markdown.input.editing

enum class EditPhase {
  Idle,
  Processing,
  Importing,
  ManagingAnchors,
}

/**
 * Tracks the current editing phase and exposes computed suppression queries.
 * Replaces the scattered boolean flags (`isProcessingTextChange`,
 * `isDuringTransaction`, `blockEmitting`, `isManagingAnchor`) that previously
 * guarded re-entrant code paths in the view.
 */
class EditSession {
  var phase: EditPhase = EditPhase.Idle
    private set

  var isTextChanging: Boolean = false
  var didTextChangeRecently: Boolean = false

  val shouldSuppressTextWatcher: Boolean
    get() = phase != EditPhase.Idle

  val shouldSuppressEvents: Boolean
    get() = phase == EditPhase.Importing

  val shouldSuppressAnchorSync: Boolean
    get() = phase == EditPhase.ManagingAnchors

  /** Runs [block] in [newPhase], then restores the enclosing phase so sessions nest. */
  fun <T> scoped(
    newPhase: EditPhase,
    block: () -> T,
  ): T {
    val previous = phase
    phase = newPhase
    try {
      return block()
    } finally {
      phase = previous
    }
  }
}
