package sh.paseo.keyboard

import android.content.Context
import android.text.Editable
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import com.facebook.react.views.view.ReactViewGroup

/**
 * Wraps the composer's text input so its send chords are taken before the IME sees them.
 *
 * Some IMEs consume a physical Return before the window callback runs: Xiaoyi synthesizes a soft
 * one in its place (#6979's device diagnostics), and with Samsung Keyboard on a Galaxy Z Fold8 the
 * window never receives a hardware Return at all. An ancestor of the focused input receives
 * `dispatchKeyEventPreIme` before the IME does, and only for real hardware presses.
 * Extending ReactViewGroup leaves the layout to React Native, so this view can stand in for the
 * composer's existing container.
 */
class HardwareKeyboardSubmitView(context: Context) : ReactViewGroup(context) {
  private val takenPresses = mutableSetOf<Int>()

  override fun dispatchKeyEventPreIme(event: KeyEvent): Boolean {
    if (takeSubmit(event)) return true
    return super.dispatchKeyEventPreIme(event)
  }

  private fun takeSubmit(event: KeyEvent): Boolean {
    if (event.action == KeyEvent.ACTION_UP) return takenPresses.remove(event.keyCode)
    if (event.action != KeyEvent.ACTION_DOWN) return false
    if (event.keyCode != KeyEvent.KEYCODE_ENTER && event.keyCode != KeyEvent.KEYCODE_NUMPAD_ENTER) {
      return false
    }
    if (event.flags and KeyEvent.FLAG_SOFT_KEYBOARD != 0) return false
    val input = findFocus() as? EditText ?: return false
    val editable = input.text
    val composingStart = BaseInputConnection.getComposingSpanStart(editable)
    val composing = composingStart >= 0
    val awaitingConversion = composing &&
      compositionAwaitsConversion(composingText(editable, composingStart), currentImeLanguage(input))
    val owns = hardwareSubmitOwns(
      "Enter", event.isShiftPressed, event.isCtrlPressed, event.isMetaPressed, event.isAltPressed,
      awaitingConversion, "Enter" in HardwareKeyboard.overlayKeys, HardwareKeyboard.submitChords,
    )
    if (!owns) return false
    // Keep the press, key-up included, from the IME and the text control; a held key sends once.
    takenPresses.add(event.keyCode)
    if (event.repeatCount == 0) {
      // The last Hangul syllable or predicted word may still be composing. It is already in the
      // editor, so commit it as typed before the composer reads the text.
      if (composing) commitComposition(input)
      HardwareKeyboard.module?.emitSubmit(event)
    }
    return true
  }
}

private fun composingText(editable: Editable, start: Int): CharSequence {
  val end = BaseInputConnection.getComposingSpanEnd(editable)
  val from = minOf(start, end).coerceIn(0, editable.length)
  val to = maxOf(start, end).coerceIn(from, editable.length)
  return editable.subSequence(from, to)
}

/** The active IME subtype's language, such as "ko" or "zh-CN", when the IME reports one. */
@Suppress("DEPRECATION") // `locale` covers IMEs that leave `languageTag` empty.
private fun currentImeLanguage(input: EditText): String? {
  val subtype = input.context.getSystemService(InputMethodManager::class.java)
    ?.currentInputMethodSubtype ?: return null
  return subtype.languageTag.ifEmpty { subtype.locale }.ifEmpty { null }
}

/**
 * Commits an IME composition as typed. Dropping the composing spans leaves the text in place, and
 * restarting input resets the IME so it neither keeps composing into the sent text nor inserts it
 * again.
 */
private fun commitComposition(input: EditText) {
  input.clearComposingText()
  input.context.getSystemService(InputMethodManager::class.java)?.restartInput(input)
}
