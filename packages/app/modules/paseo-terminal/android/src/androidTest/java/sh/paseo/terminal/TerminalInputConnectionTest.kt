package sh.paseo.terminal

import android.text.InputType
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Exercises `TerminalInputConnection` and `PaseoTerminalInputView` against real Android
 * `SpannableStringBuilder`, `BaseInputConnection`, `EditorInfo`, and `KeyEvent` instances.
 */
@RunWith(AndroidJUnit4::class)
class TerminalInputConnectionTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()

  private class RecordedTerminal {
    val chunks = mutableListOf<String>()
    val keys = mutableListOf<TerminalKeyPayload>()

    fun write(data: String) {
      chunks.add(data)
    }

    fun key(payload: TerminalKeyPayload) {
      keys.add(payload)
    }

    val rawStream: String
      get() = chunks.joinToString("")

    /** Applies `\x7f` rubouts onto a simulated terminal line buffer to verify visible text. */
    fun applyToLine(initial: String = ""): String {
      val codePoints = mutableListOf<Int>()
      initial.codePoints().forEach { codePoints.add(it) }
      rawStream.codePoints().forEach { cp ->
        if (cp == 0x7f) {
          if (codePoints.isNotEmpty()) codePoints.removeAt(codePoints.lastIndex)
        } else {
          codePoints.add(cp)
        }
      }
      val sb = StringBuilder()
      codePoints.forEach { sb.appendCodePoint(it) }
      return sb.toString()
    }
  }

  private fun withInputHarness(
    block: (View, TerminalInputConnection, EditorInfo, RecordedTerminal) -> Unit,
  ) {
    instrumentation.runOnMainSync {
      val context = instrumentation.targetContext
      val terminal = RecordedTerminal()
      val view = object : View(context) {
        init {
          isFocusable = true
          isFocusableInTouchMode = true
        }
      }
      val editorInfo = EditorInfo()
      val connection = TerminalInputConnection(
        targetView = view,
        onInput = terminal::write,
        onTerminalKey = terminal::key,
      )
      TerminalInputConnection.configureEditorInfo(editorInfo)
      block(view, connection, editorInfo, terminal)
    }
  }

  @Test
  fun editorInfoDisablesSuggestionsFullscreenAndPersonalizedLearning() {
    instrumentation.runOnMainSync {
      val context = instrumentation.targetContext
      val editorInfo = EditorInfo()
      val view = PaseoTerminalInputView.createForTest(context)
      assertTrue("Terminal input view must declare itself as a text editor", view.onCheckIsTextEditor())
      assertTrue("Terminal input view must be focusable", view.isFocusable && view.isFocusableInTouchMode)
      val connection = view.onCreateInputConnection(editorInfo)
      assertTrue("onCreateInputConnection must return TerminalInputConnection", connection is TerminalInputConnection)
      assertEquals(
        InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS,
        editorInfo.inputType,
      )
      assertEquals(EditorInfo.IME_ACTION_NONE, editorInfo.imeOptions and EditorInfo.IME_MASK_ACTION)
      assertNotEquals(0, editorInfo.imeOptions and EditorInfo.IME_FLAG_NO_FULLSCREEN)
      assertNotEquals(0, editorInfo.imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING)
    }
  }

  @Test
  fun batchedCommitTextAndSetComposingTextDoNotDoubleCharacters() {
    withInputHarness { _, ic, _, terminal ->
      for (ch in listOf("a", "b", "c", "d")) {
        ic.beginBatchEdit()
        ic.commitText(ch, 1)
        ic.endBatchEdit()
      }
      assertEquals("abcd", terminal.rawStream)
      assertEquals("", ic.editable.toString())

      // Coalesced setComposingText + finishComposingText inside one batch emits once.
      ic.beginBatchEdit()
      ic.setComposingText("ef", 1)
      ic.finishComposingText()
      ic.endBatchEdit()
      assertEquals("abcdef", terminal.rawStream)
      assertEquals("", ic.editable.toString())
    }
  }

  @Test
  fun backspaceWorksAcrossAllThreeImePaths() {
    withInputHarness { _, ic, _, terminal ->
      ic.commitText("abcd", 1)
      assertEquals("abcd", terminal.applyToLine())

      // Path 1: deleteSurroundingText (empty editable after commit)
      ic.deleteSurroundingText(0, 0)
      assertEquals("abcd", terminal.applyToLine())
      ic.deleteSurroundingText(1, 0)
      assertEquals("abc", terminal.applyToLine())

      // Path 2: deleteSurroundingTextInCodePoints (empty editable)
      ic.deleteSurroundingTextInCodePoints(1, 0)
      assertEquals("ab", terminal.applyToLine())

      // Path 2b: deleteSurroundingTextInCodePoints on surrogate-pair emoji in composing buffer
      ic.setComposingText("😀", 1)
      assertEquals("ab😀", terminal.applyToLine())
      ic.deleteSurroundingTextInCodePoints(1, 0)
      assertEquals("ab", terminal.applyToLine())

      // Path 3: sendKeyEvent(KEYCODE_DEL) emits on ACTION_DOWN only, not ACTION_UP
      ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL))
      ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DEL))
      assertEquals("a", terminal.applyToLine())

      // Multi-char deleteSurroundingText on empty buffer
      ic.commitText("xyz", 1)
      ic.deleteSurroundingText(2, 0)
      assertEquals("ax", terminal.applyToLine())
    }
  }

  @Test
  fun hangulCompositionSyllableMigrationBackspaceAndPostEnter() {
    withInputHarness { _, ic, _, terminal ->
      // ㅎ -> 하 -> 한
      ic.setComposingText("ㅎ", 1)
      ic.setComposingText("하", 1)
      ic.setComposingText("한", 1)
      assertEquals("한", terminal.applyToLine())

      // Final consonant migration: 한 + ㅏ -> commit 하 + compose 나 in one batch
      ic.beginBatchEdit()
      ic.commitText("하", 1)
      ic.setComposingText("나", 1)
      ic.endBatchEdit()
      assertEquals("하나", terminal.applyToLine())

      // Continue composing second syllable: 나 -> 난
      ic.setComposingText("난", 1)
      assertEquals("하난", terminal.applyToLine())

      // Backspace decomposes 난 -> 나 -> ㄴ -> "" (leaving 하) -> ""
      ic.setComposingText("나", 1)
      assertEquals("하나", terminal.applyToLine())
      ic.setComposingText("ㄴ", 1)
      assertEquals("하ㄴ", terminal.applyToLine())
      ic.commitText("", 1)
      assertEquals("하", terminal.applyToLine())
      ic.deleteSurroundingText(1, 0)
      assertEquals("", terminal.applyToLine())

      // Submit via Enter, then immediately type 한글 with zero stale newline residue (#7164)
      ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
      ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
      ic.setComposingText("ㅎ", 1)
      ic.setComposingText("하", 1)
      ic.setComposingText("한", 1)
      ic.beginBatchEdit()
      ic.commitText("한", 1)
      ic.setComposingText("ㄱ", 1)
      ic.endBatchEdit()
      ic.setComposingText("그", 1)
      ic.setComposingText("글", 1)
      ic.finishComposingText()

      assertEquals("\r한글", terminal.applyToLine())
    }
  }

  @Test
  fun pinyinCompositionAndMixedChineseThenLatinCandidate() {
    withInputHarness { _, ic, _, terminal ->
      // Pinyin reading: nihao -> ni hao -> 你好
      ic.setComposingText("n", 1)
      ic.setComposingText("ni", 1)
      ic.setComposingText("nih", 1)
      ic.setComposingText("niha", 1)
      ic.setComposingText("ni hao", 1)
      ic.beginBatchEdit()
      ic.commitText("你好", 1)
      ic.endBatchEdit()
      assertEquals("你好", terminal.applyToLine())

      // WeChat Keyboard #9121: immediately compose English and pick 2nd suggestion `hello`
      ic.setComposingText("h", 1)
      ic.setComposingText("he", 1)
      ic.setComposingText("hel", 1)
      ic.beginBatchEdit()
      ic.commitText("hello", 1)
      ic.endBatchEdit()
      assertEquals("你好hello", terminal.applyToLine())

      // Backspace right after Latin candidate deletes from terminal visibly
      ic.deleteSurroundingText(1, 0)
      assertEquals("你好hell", terminal.applyToLine())
    }
  }

  @Test
  fun latinCandidatesAutocorrectAndRepeatedClipboardCommit() {
    withInputHarness { _, ic, _, terminal ->
      // Candidate completion: hel -> hello
      ic.setComposingText("hel", 1)
      ic.commitText("hello", 1)
      assertEquals("hello", terminal.applyToLine())

      // Autocorrect replacement inside composing span: teh -> the
      ic.setComposingText("teh", 1)
      ic.commitText("the", 1)
      assertEquals("hellothe", terminal.applyToLine())

      // Repeated clipboard paste of identical text works because editable clears after commit
      ic.commitText("echo ok", 1)
      ic.commitText("echo ok", 1)
      assertEquals("hellotheecho okecho ok", terminal.applyToLine())
    }
  }

  @Test
  fun enterKeyAndEditorActionEmitSingleCarriageReturn() {
    withInputHarness { _, ic, _, terminal ->
      ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
      ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
      assertEquals("\r", terminal.rawStream)

      ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_NUMPAD_ENTER))
      ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_NUMPAD_ENTER))
      assertEquals("\r\r", terminal.rawStream)

      ic.performEditorAction(EditorInfo.IME_ACTION_NONE)
      assertEquals("\r\r\r", terminal.rawStream)

      ic.commitText("\n", 1)
      assertEquals("\r\r\r\r", terminal.rawStream)
    }
  }

  @Test
  fun physicalKeyboardKeysAndDeadKeyAccents() {
    instrumentation.runOnMainSync {
      val context = instrumentation.targetContext
      val terminal = RecordedTerminal()
      val view = PaseoTerminalInputView.createForTest(
        context = context,
        onInput = terminal::write,
        onTerminalKey = terminal::key,
      )
      view.onCreateInputConnection(EditorInfo())

      // Enter & Numpad Enter: ACTION_DOWN + ACTION_UP -> single \r each
      assertTrue(view.onKeyDown(KeyEvent.KEYCODE_ENTER, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER)))
      assertTrue(view.onKeyUp(KeyEvent.KEYCODE_ENTER, KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER)))
      assertTrue(view.onKeyDown(KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_NUMPAD_ENTER)))
      assertTrue(view.onKeyUp(KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_NUMPAD_ENTER)))
      assertEquals("\r\r", terminal.rawStream)

      // Tab, Shift+Tab, Escape, Del
      assertTrue(view.onKeyDown(KeyEvent.KEYCODE_TAB, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_TAB)))
      assertTrue(view.onKeyDown(KeyEvent.KEYCODE_TAB, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_TAB, 0, KeyEvent.META_SHIFT_ON)))
      assertTrue(view.onKeyDown(KeyEvent.KEYCODE_ESCAPE, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ESCAPE)))
      assertTrue(view.onKeyDown(KeyEvent.KEYCODE_DEL, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL)))
      assertEquals("\r\r\t\u001b[Z\u001b\u007f", terminal.rawStream)

      // Ctrl+C and Alt+B
      assertTrue(view.onKeyDown(KeyEvent.KEYCODE_C, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_C, 0, KeyEvent.META_CTRL_ON)))
      assertTrue(view.onKeyDown(KeyEvent.KEYCODE_B, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_B, 0, KeyEvent.META_ALT_ON)))
      assertEquals("\r\r\t\u001b[Z\u001b\u007f\u0003\u001bb", terminal.rawStream)

      // Printable key
      assertTrue(view.onKeyDown(KeyEvent.KEYCODE_A, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_A)))
      assertEquals("\r\r\t\u001b[Z\u001b\u007f\u0003\u001bba", terminal.rawStream)

      // Dead key accent (acute + e -> é)
      val deadAcuteEvent = object : KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_E) {
        override fun getUnicodeChar(metaState: Int): Int =
          KeyCharacterMap.COMBINING_ACCENT or '\u00b4'.code
      }
      assertTrue(view.onKeyDown(KeyEvent.KEYCODE_E, deadAcuteEvent))
      assertTrue(view.onKeyDown(KeyEvent.KEYCODE_E, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_E)))
      assertEquals("\r\r\t\u001b[Z\u001b\u007f\u0003\u001bbaé", terminal.rawStream)

      // Meta shortcuts pass through unhandled
      assertFalse(view.onKeyDown(KeyEvent.KEYCODE_TAB, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_TAB, 0, KeyEvent.META_META_ON)))
    }
  }

  @Test
  fun composingStateIsExposedOnViewForHardwareKeyboardModule() {
    instrumentation.runOnMainSync {
      val context = instrumentation.targetContext
      val view = PaseoTerminalInputView.createForTest(context)
      // Mirrors React Native BaseViewManager.setTestId, which overwrites the unkeyed View tag.
      view.setTag("terminal-native-input")
      val ic = checkNotNull(view.onCreateInputConnection(EditorInfo()))
      assertFalse(view.isComposingText())

      ic.setComposingText("한", 1)
      assertTrue(view.isComposingText())

      ic.commitText("한", 1)
      assertFalse(view.isComposingText())
    }
  }
}
