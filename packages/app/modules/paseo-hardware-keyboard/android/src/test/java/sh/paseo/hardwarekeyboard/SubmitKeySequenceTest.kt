package sh.paseo.hardwarekeyboard

import org.junit.Assert.assertEquals
import org.junit.Test

private const val ENTER = 66
private const val NUMPAD_ENTER = 160

class SubmitKeySequenceTest {
  private val sequence = SubmitKeySequence()
  private var canSubmit = true
  private var canSubmitChecks = 0

  private fun press(
    phase: SubmitKeyPhase,
    submitKey: Boolean = true,
    repeatCount: Int = 0,
    keyCode: Int = ENTER,
  ): SubmitKeyDecision =
    sequence.decide(SubmitKeyInput(keyCode, phase, repeatCount, isSubmitKey = submitKey)) {
      canSubmitChecks += 1
      canSubmit
    }

  @Test
  fun enterSubmitsOnceAndConsumesRepeatsAndUp() {
    assertEquals(SubmitKeyDecision.SUBMIT, press(SubmitKeyPhase.DOWN))
    assertEquals(SubmitKeyDecision.CONSUME, press(SubmitKeyPhase.DOWN, repeatCount = 1))
    assertEquals(SubmitKeyDecision.CONSUME, press(SubmitKeyPhase.DOWN, repeatCount = 2))
    assertEquals(SubmitKeyDecision.CONSUME, press(SubmitKeyPhase.OTHER))
    assertEquals(SubmitKeyDecision.CONSUME, press(SubmitKeyPhase.UP))
    assertEquals(1, canSubmitChecks)
  }

  @Test
  fun consumesRepeatsAndUpAfterShiftIsPressedMidPress() {
    assertEquals(SubmitKeyDecision.SUBMIT, press(SubmitKeyPhase.DOWN))
    assertEquals(SubmitKeyDecision.CONSUME, press(SubmitKeyPhase.DOWN, submitKey = false, repeatCount = 1))
    assertEquals(SubmitKeyDecision.CONSUME, press(SubmitKeyPhase.UP, submitKey = false))
  }

  @Test
  fun consumesRepeatsAndUpAfterSubmitDisablesTheComposer() {
    assertEquals(SubmitKeyDecision.SUBMIT, press(SubmitKeyPhase.DOWN))
    canSubmit = false
    assertEquals(SubmitKeyDecision.CONSUME, press(SubmitKeyPhase.DOWN, repeatCount = 1))
    assertEquals(SubmitKeyDecision.CONSUME, press(SubmitKeyPhase.UP))
  }

  @Test
  fun shiftOrSoftKeyboardEnterPassesThroughWithoutCheckingTheComposer() {
    assertEquals(SubmitKeyDecision.PASS_THROUGH, press(SubmitKeyPhase.DOWN, submitKey = false))
    assertEquals(
      SubmitKeyDecision.PASS_THROUGH,
      press(SubmitKeyPhase.DOWN, submitKey = false, repeatCount = 1),
    )
    assertEquals(SubmitKeyDecision.PASS_THROUGH, press(SubmitKeyPhase.UP, submitKey = false))
    assertEquals(0, canSubmitChecks)
  }

  @Test
  fun enterPassesThroughWhenTheComposerCannotSubmit() {
    // Unrelated focus, a blocked send, or a release after disable.
    canSubmit = false
    assertEquals(SubmitKeyDecision.PASS_THROUGH, press(SubmitKeyPhase.DOWN))
    assertEquals(SubmitKeyDecision.PASS_THROUGH, press(SubmitKeyPhase.DOWN, repeatCount = 1))
    assertEquals(SubmitKeyDecision.PASS_THROUGH, press(SubmitKeyPhase.UP))
  }

  @Test
  fun aRepeatWithoutAHandledInitialDownNeverSubmits() {
    assertEquals(SubmitKeyDecision.PASS_THROUGH, press(SubmitKeyPhase.DOWN, repeatCount = 3))
    assertEquals(0, canSubmitChecks)
  }

  @Test
  fun numpadEnterIsTrackedSeparatelyFromEnter() {
    assertEquals(SubmitKeyDecision.SUBMIT, press(SubmitKeyPhase.DOWN, keyCode = NUMPAD_ENTER))
    assertEquals(SubmitKeyDecision.PASS_THROUGH, press(SubmitKeyPhase.UP, keyCode = ENTER))
    assertEquals(SubmitKeyDecision.CONSUME, press(SubmitKeyPhase.UP, keyCode = NUMPAD_ENTER))
  }

  @Test
  fun aFreshPlainPressEndsASequenceWhoseUpWasLost() {
    assertEquals(SubmitKeyDecision.SUBMIT, press(SubmitKeyPhase.DOWN))
    // The UP never arrives, e.g. focus moved to another window while the key was held.
    assertEquals(SubmitKeyDecision.PASS_THROUGH, press(SubmitKeyPhase.DOWN, submitKey = false))
    assertEquals(SubmitKeyDecision.PASS_THROUGH, press(SubmitKeyPhase.UP, submitKey = false))
  }

  @Test
  fun eachNewPressSubmitsAgain() {
    assertEquals(SubmitKeyDecision.SUBMIT, press(SubmitKeyPhase.DOWN))
    assertEquals(SubmitKeyDecision.CONSUME, press(SubmitKeyPhase.UP))
    assertEquals(SubmitKeyDecision.SUBMIT, press(SubmitKeyPhase.DOWN))
    assertEquals(SubmitKeyDecision.CONSUME, press(SubmitKeyPhase.UP))
  }

  @Test
  fun resetForgetsAnUnfinishedSequence() {
    assertEquals(SubmitKeyDecision.SUBMIT, press(SubmitKeyPhase.DOWN))
    sequence.reset()
    assertEquals(SubmitKeyDecision.PASS_THROUGH, press(SubmitKeyPhase.UP))
  }
}
