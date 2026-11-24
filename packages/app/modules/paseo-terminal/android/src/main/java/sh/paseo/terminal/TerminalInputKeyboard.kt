package sh.paseo.terminal

import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.TextView
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.util.ReactFindViewUtil

// Matched against the hidden terminal input's `nativeID`
// (TERMINAL_INPUT_NATIVE_ID in terminal-input.native.tsx).
private const val TERMINAL_INPUT_NATIVE_ID = "paseo-terminal-input"

/**
 * Keeps what is typed at a terminal prompt, such as a `sudo` password, out of the keyboard's
 * learned words. React Native's TextInput has no prop for IME_FLAG_NO_PERSONALIZED_LEARNING, so the
 * flag is added when the input receives its `nativeID`, before it can take focus.
 *
 * React Native replaces `imeOptions` when `returnKeyType` or `disableFullscreenUI` is set, so the
 * terminal input sets neither.
 */
internal object TerminalInputKeyboard : ReactFindViewUtil.OnMultipleViewsFoundListener {
  fun install() {
    UiThreadUtil.runOnUiThread {
      ReactFindViewUtil.addViewsListener(this, setOf(TERMINAL_INPUT_NATIVE_ID))
    }
  }

  override fun onViewFound(view: View, nativeId: String) {
    val input = view as? TextView ?: return
    input.imeOptions = input.imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
  }
}
