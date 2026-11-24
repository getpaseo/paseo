package sh.paseo.terminal

import android.text.InputType
import android.view.inputmethod.EditorInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.textinput.ReactEditText
import com.facebook.react.views.textinput.ReactTextInputManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Builds React Native's own text input and applies `nativeID` through its view manager, which is
 * how Fabric mounts the hidden terminal input. The app runs bridgeless, so the context is too.
 */
@RunWith(AndroidJUnit4::class)
class TerminalInputKeyboardTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()

  @Test fun terminalInputAsksTheKeyboardNotToLearnWhatIsTyped() {
    onInput("paseo-terminal-input") { input, editorInfo ->
      assertNotEquals(
        "The keyboard must not learn passwords typed at a terminal prompt",
        0,
        editorInfo.imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING,
      )
      assertEquals(
        "Suggestions stay off and the input stays multiline",
        InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_FLAG_MULTI_LINE,
        editorInfo.inputType and (InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_FLAG_MULTI_LINE),
      )
      val connection = checkNotNull(input.onCreateInputConnection(EditorInfo()))
      connection.setComposingText("su", 1)
      connection.commitText("sudo ls", 1)
      connection.deleteSurroundingText(1, 0)
      assertEquals("sudo l", input.text.toString())
    }
  }

  @Test fun otherInputsKeepPersonalizedLearning() {
    onInput("message-composer") { _, editorInfo ->
      assertEquals(0, editorInfo.imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING)
    }
  }

  private fun onInput(nativeId: String, check: (ReactEditText, EditorInfo) -> Unit) {
    TerminalInputKeyboard.install()
    instrumentation.runOnMainSync {
      val app = instrumentation.targetContext
      DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(app)
      val react = object : BridgeReactContext(app) {
        override fun isBridgeless() = true
      }
      val input = ReactEditText(ThemedReactContext(react, app, null, -1))
      input.inputType = InputType.TYPE_CLASS_TEXT or
        InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
        InputType.TYPE_TEXT_FLAG_MULTI_LINE
      ReactTextInputManager().setNativeId(input, nativeId)
      val editorInfo = EditorInfo()
      input.onCreateInputConnection(editorInfo)
      check(input, editorInfo)
    }
  }
}
