package sh.paseo.keyboard

import android.app.Activity
import android.content.Intent
import android.view.KeyEvent
import android.widget.EditText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises the real Android window and editable that receive physical keys. */
@RunWith(AndroidJUnit4::class)
class TerminalArrowTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private var activity: Activity? = null

  @After fun finish() {
    instrumentation.runOnMainSync {
      activity?.let {
        HardwareKeyboard.release(it.window)
        it.finish()
      }
    }
  }

  @Test fun physicalArrowsDoNotMoveTheTerminalInputCaret() {
    withInput(terminal = true) { input, host ->
      for (code in listOf(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_DOWN)) {
        for (modifiers in listOf(0, KeyEvent.META_SHIFT_ON, KeyEvent.META_ALT_ON, KeyEvent.META_CTRL_ON)) {
          input.setSelection(3)
          for (repeat in 0..2) {
            assertTrue(host.window.callback.dispatchKeyEvent(KeyEvent(0, 0, KeyEvent.ACTION_DOWN, code, repeat, modifiers)))
            assertEquals("Physical arrows must leave the hidden input caret at the end", 3, input.selectionStart)
          }
          assertTrue(host.window.callback.dispatchKeyEvent(KeyEvent(0, 0, KeyEvent.ACTION_UP, code, 0, modifiers)))
        }
      }
      host.window.callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_X))
      host.window.callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_X))
      assertEquals("abcx", input.text.toString())
    }
  }

  @Test fun physicalArrowsStillEditOtherTextFields() {
    withInput(terminal = false) { input, host ->
      host.window.callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT))
      host.window.callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_LEFT))
      assertEquals(2, input.selectionStart)
      host.window.callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_X))
      host.window.callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_X))
      assertEquals("abxc", input.text.toString())
    }
  }

  private fun withInput(terminal: Boolean, check: (EditText, Activity) -> Unit) {
    val host = instrumentation.startActivitySync(
      Intent(instrumentation.targetContext, Activity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
    activity = host
    lateinit var input: EditText
    instrumentation.runOnMainSync {
      input = EditText(host)
      if (terminal) input.setTag(com.facebook.react.R.id.view_tag_native_id, "paseo-terminal-input")
      host.setContentView(input)
      input.setText("abc")
      input.requestFocus()
      input.setSelection(3)
      HardwareKeyboard.observe(host.window)
    }
    instrumentation.waitForIdleSync()
    instrumentation.runOnMainSync {
      assertSame("The editable must own window focus before keys are dispatched", input, host.window.currentFocus)
      check(input, host)
    }
  }
}
