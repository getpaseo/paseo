package sh.paseo.terminal

import android.content.Context
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.TextView
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.util.ReactFindViewUtil
import java.lang.ref.WeakReference

// Matched against the hidden terminal input's `nativeID`
// (TERMINAL_INPUT_NATIVE_ID in terminal-input.native.tsx).
private const val TERMINAL_INPUT_NATIVE_ID = "paseo-terminal-input"

/**
 * Keeps what is typed at a terminal prompt, such as a `sudo` password, out of the keyboard's
 * learned words. React Native's TextInput has no prop for IME_FLAG_NO_PERSONALIZED_LEARNING, so the
 * flag is added when the input receives its `nativeID`, before it can take focus.
 *
 * Gboard treats the flag as incognito typing and turns its voice typing off, so the user can allow
 * keyboard learning from the app settings (`setAllowLearning`). It is off by default.
 *
 * React Native replaces `imeOptions` when `returnKeyType` or `disableFullscreenUI` is set, so the
 * terminal input sets neither.
 */
internal object TerminalInputKeyboard : ReactFindViewUtil.OnMultipleViewsFoundListener {
  private var allowLearning = false
  // Every mounted terminal input, such as split panes. Cleared references are pruned on use.
  private val inputs = mutableListOf<WeakReference<TextView>>()

  fun install() {
    UiThreadUtil.runOnUiThread {
      ReactFindViewUtil.addViewsListener(this, setOf(TERMINAL_INPUT_NATIVE_ID))
    }
  }

  /** Applies a changed setting to every input that already exists and restarts the keyboard on it. */
  fun setAllowLearning(allow: Boolean) {
    UiThreadUtil.runOnUiThread {
      if (allowLearning == allow) return@runOnUiThread
      allowLearning = allow
      liveInputs().forEach { view ->
        applyLearningFlag(view)
        if (view.isFocused) {
          val service = view.context.getSystemService(Context.INPUT_METHOD_SERVICE)
          (service as? InputMethodManager)?.restartInput(view)
        }
      }
    }
  }

  override fun onViewFound(view: View, nativeId: String) {
    val textView = view as? TextView ?: return
    if (liveInputs().none { it === textView }) inputs.add(WeakReference(textView))
    applyLearningFlag(textView)
  }

  private fun liveInputs(): List<TextView> {
    inputs.removeAll { it.get() == null }
    return inputs.mapNotNull { it.get() }
  }

  private fun applyLearningFlag(input: TextView) {
    input.imeOptions =
      if (allowLearning) {
        input.imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING.inv()
      } else {
        input.imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
      }
  }
}
