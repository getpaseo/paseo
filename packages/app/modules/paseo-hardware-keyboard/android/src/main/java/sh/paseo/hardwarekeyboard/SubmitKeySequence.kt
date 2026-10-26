package sh.paseo.hardwarekeyboard

/** The facts about one Enter key event that decide hardware-keyboard submission. */
internal data class SubmitKeyInput(
  val keyCode: Int,
  val phase: SubmitKeyPhase,
  val repeatCount: Int,
  /** A hardware keyboard Enter without Shift. Shift+Enter and soft keyboards insert a newline. */
  val isSubmitKey: Boolean,
)

internal enum class SubmitKeyPhase { DOWN, UP, OTHER }

internal enum class SubmitKeyDecision { PASS_THROUGH, SUBMIT, CONSUME }

/**
 * Tracks Enter presses so a handled press is consumed from its initial DOWN through its UP.
 *
 * Kept free of Android types so the rules run on a plain JVM in unit tests. The caller passes only
 * Enter and numpad Enter events.
 */
internal class SubmitKeySequence {
  private val consumedKeyCodes = mutableSetOf<Int>()

  /**
   * [canSubmit] is evaluated only for an initial submit-key DOWN. Repeats and the UP of a handled
   * press are consumed regardless of it, because submitting usually disables the composer before
   * the key is released.
   */
  fun decide(input: SubmitKeyInput, canSubmit: () -> Boolean): SubmitKeyDecision {
    if (input.phase == SubmitKeyPhase.UP) {
      return if (consumedKeyCodes.remove(input.keyCode)) {
        SubmitKeyDecision.CONSUME
      } else {
        SubmitKeyDecision.PASS_THROUGH
      }
    }
    if (input.phase == SubmitKeyPhase.DOWN && input.repeatCount == 0) {
      // A fresh press ends any earlier sequence whose UP never arrived (focus moved, app paused).
      consumedKeyCodes.remove(input.keyCode)
      if (!input.isSubmitKey || !canSubmit()) {
        return SubmitKeyDecision.PASS_THROUGH
      }
      consumedKeyCodes.add(input.keyCode)
      return SubmitKeyDecision.SUBMIT
    }
    return if (input.keyCode in consumedKeyCodes) {
      SubmitKeyDecision.CONSUME
    } else {
      SubmitKeyDecision.PASS_THROUGH
    }
  }

  fun reset() {
    consumedKeyCodes.clear()
  }
}
