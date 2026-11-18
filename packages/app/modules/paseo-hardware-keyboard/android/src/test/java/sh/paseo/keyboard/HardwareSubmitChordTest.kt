package sh.paseo.keyboard
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
class HardwareSubmitChordTest {
  private val enterSends = setOf("Enter", "Control+Enter", "Meta+Enter")
  private val modEnterSends = setOf("Control+Enter", "Meta+Enter")

  private fun owns(
    chords: Set<String>,
    key: String = "Enter",
    shift: Boolean = false,
    ctrl: Boolean = false,
    meta: Boolean = false,
    alt: Boolean = false,
    awaitingConversion: Boolean = false,
    overlayClaimsReturn: Boolean = false,
  ) = hardwareSubmitOwns(key, shift, ctrl, meta, alt, awaitingConversion, overlayClaimsReturn, chords)

  @Test fun enterShortcutTakesPlainAndModifiedReturn() {
    assertTrue(owns(enterSends))
    assertTrue(owns(enterSends, ctrl = true))
    assertTrue(owns(enterSends, meta = true))
  }
  @Test fun modEnterShortcutLeavesPlainReturnWithTheTextControl() {
    assertFalse(owns(modEnterSends))
    assertTrue(owns(modEnterSends, ctrl = true))
    assertTrue(owns(modEnterSends, meta = true))
  }
  @Test fun shiftAltAndUnpublishedCombinationsStayWithTheTextControl() {
    assertFalse(owns(enterSends, shift = true))
    assertFalse(owns(modEnterSends, ctrl = true, shift = true))
    assertFalse(owns(enterSends, alt = true))
    assertFalse(owns(enterSends, ctrl = true, meta = true))
  }
  @Test fun plainReturnConfirmsAConversion() {
    assertFalse(owns(enterSends, awaitingConversion = true))
  }
  @Test fun aModifierChordSendsThroughAConversion() {
    assertTrue(owns(modEnterSends, ctrl = true, awaitingConversion = true))
    assertTrue(owns(enterSends, meta = true, awaitingConversion = true))
  }
  @Test fun anOverlayThatDeclaredReturnKeepsEveryReturnChord() {
    assertFalse(owns(enterSends, overlayClaimsReturn = true))
    assertFalse(owns(modEnterSends, ctrl = true, overlayClaimsReturn = true))
  }
  @Test fun nothingPublishedTakesNothing() {
    assertFalse(owns(emptySet()))
    assertFalse(owns(emptySet(), ctrl = true))
  }
  @Test fun otherKeysStayWithTheTextControl() {
    assertFalse(owns(enterSends, key = "KeyA"))
    assertFalse(owns(enterSends, key = "Tab"))
  }

  @Test fun hangulAndPredictedLatinWordsAreTypedText() {
    assertFalse(compositionAwaitsConversion("요", "ko"))
    assertFalse(compositionAwaitsConversion("하세요", null))
    assertFalse(compositionAwaitsConversion("hello", "en-US"))
    assertFalse(compositionAwaitsConversion("hello", null))
  }
  @Test fun japaneseAndChineseScriptsAwaitConversion() {
    assertTrue(compositionAwaitsConversion("にほんご", null))
    assertTrue(compositionAwaitsConversion("カタカナ", null))
    assertTrue(compositionAwaitsConversion("日本", null))
    assertTrue(compositionAwaitsConversion("ㄋㄧˇ", null))
  }
  @Test fun latinPinyinAndRomajiAwaitConversionByTheImeLanguage() {
    assertTrue(compositionAwaitsConversion("nihao", "zh-CN"))
    assertTrue(compositionAwaitsConversion("nihao", "zh_TW"))
    assertTrue(compositionAwaitsConversion("nihongo", "ja-JP"))
  }
}
