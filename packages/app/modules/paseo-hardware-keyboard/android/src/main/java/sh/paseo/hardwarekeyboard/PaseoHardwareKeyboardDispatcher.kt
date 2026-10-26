package sh.paseo.hardwarekeyboard

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import com.facebook.react.R

/** The modifiers of the initial DOWN of a consumed Enter press, for the composer's Enter rules. */
internal data class SubmitKeyPress(
  val targetNativeId: String,
  val ctrlKey: Boolean,
  val metaKey: Boolean,
)

/**
 * Submits the focused composer on a hardware keyboard Enter.
 *
 * MainActivity calls [dispatchKeyEvent] before the view hierarchy, so the focused ReactEditText
 * never inserts a newline for a handled press. All state is confined to the main thread.
 */
object PaseoHardwareKeyboardDispatcher {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val sequence = SubmitKeySequence()
  private var targetNativeId: String? = null
  private var onSubmit: ((SubmitKeyPress) -> Unit)? = null

  @JvmStatic
  fun dispatchKeyEvent(activity: Activity, event: KeyEvent): Boolean {
    if (event.keyCode != KeyEvent.KEYCODE_ENTER && event.keyCode != KeyEvent.KEYCODE_NUMPAD_ENTER) {
      return false
    }
    return dispatchEnterKey(activity.currentFocus, event)
  }

  /** Handles an Enter or numpad Enter event for the activity's focused view. */
  internal fun dispatchEnterKey(focused: View?, event: KeyEvent): Boolean {
    var submitTarget: String? = null
    val decision = sequence.decide(event.toSubmitKeyInput()) {
      submitTarget = resolveSubmitTarget(focused)
      submitTarget != null
    }
    val target = submitTarget
    if (decision == SubmitKeyDecision.SUBMIT && target != null) {
      finishComposition(focused)
      // JS listeners filter on the target, so only the composer that owns this view submits even
      // while another composer's controller is still enabled.
      onSubmit?.invoke(SubmitKeyPress(target, event.isCtrlPressed, event.isMetaPressed))
    }
    return decision != SubmitKeyDecision.PASS_THROUGH
  }

  internal fun attach(listener: (SubmitKeyPress) -> Unit) {
    mainHandler.post { onSubmit = listener }
  }

  /** Detaches only [listener], so a module torn down after its replacement attached is a no-op. */
  internal fun detach(listener: (SubmitKeyPress) -> Unit) {
    mainHandler.post {
      if (onSubmit !== listener) return@post
      onSubmit = null
      targetNativeId = null
      sequence.reset()
    }
  }

  /**
   * Disabling only releases the composer that owns submission, so a blur arriving after the next
   * composer's focus cannot clear the new owner.
   */
  internal fun setEnabled(enabled: Boolean, nativeId: String?) {
    mainHandler.post {
      if (enabled) {
        targetNativeId = nativeId
      } else if (nativeId == null || targetNativeId == nativeId) {
        targetNativeId = null
      }
    }
  }

  /** The registered composer's nativeID when it is the focused view, otherwise null. */
  private fun resolveSubmitTarget(focused: View?): String? {
    val target = targetNativeId ?: return null
    if (onSubmit == null || focused == null) return null
    if (focused.getTag(R.id.view_tag_native_id) != target) return null
    return target
  }

  /**
   * Ends any composing region before submitting, keeping its text. Every physical key reaches the
   * IME first, so a physical Enter that gets here was declined by the IME. The policy is to
   * finalize the text on such an Enter; IMEs that consume Enter to accept a conversion never reach
   * this point, and unusual IMEs that decline Enter mid-conversion are not verified.
   *
   * Restarting input makes the IME drop its composing state. Without it, when the composer keeps
   * its text (autocomplete selection, blocked send), the IME's next setComposingText would insert
   * the word again instead of replacing it. The text is not changed, so JS keeps its latest copy.
   */
  private fun finishComposition(focused: View?) {
    val editText = focused as? EditText ?: return
    val text = editText.text ?: return
    if (BaseInputConnection.getComposingSpanStart(text) == -1) return
    BaseInputConnection.removeComposingSpans(text)
    editText.context.getSystemService(InputMethodManager::class.java)?.restartInput(editText)
  }

  private fun KeyEvent.toSubmitKeyInput() = SubmitKeyInput(
    keyCode = keyCode,
    phase = when (action) {
      KeyEvent.ACTION_DOWN -> SubmitKeyPhase.DOWN
      KeyEvent.ACTION_UP -> SubmitKeyPhase.UP
      else -> SubmitKeyPhase.OTHER
    },
    repeatCount = repeatCount,
    // IMEs send Enter as a virtual-keyboard event; only physical keyboards submit.
    isSubmitKey = !isShiftPressed &&
      deviceId != KeyCharacterMap.VIRTUAL_KEYBOARD &&
      (flags and KeyEvent.FLAG_SOFT_KEYBOARD) == 0,
  )
}
