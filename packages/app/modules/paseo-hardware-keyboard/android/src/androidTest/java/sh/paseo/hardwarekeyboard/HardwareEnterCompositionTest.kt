package sh.paseo.hardwarekeyboard

import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.R
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

private const val COMPOSER_ID = "composer"
private const val PHYSICAL_KEYBOARD_ID = 25

@RunWith(AndroidJUnit4::class)
class HardwareEnterCompositionTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val presses = mutableListOf<SubmitKeyPress>()
  private val listener: (SubmitKeyPress) -> Unit = { presses.add(it) }
  private lateinit var composer: EditText

  @Before fun ownComposerWithComposingWord() {
    instrumentation.runOnMainSync {
      composer = EditText(instrumentation.targetContext).apply {
        setTag(R.id.view_tag_native_id, COMPOSER_ID)
      }
      // The IME's own call: SwiftKey keeps the word being typed in a composing region.
      composer.onCreateInputConnection(EditorInfo())!!.setComposingText("тест", 1)
      PaseoHardwareKeyboardDispatcher.attach(listener)
      PaseoHardwareKeyboardDispatcher.setEnabled(true, COMPOSER_ID)
    }
    instrumentation.waitForIdleSync()
  }

  @After fun releaseDispatcher() {
    instrumentation.runOnMainSync { PaseoHardwareKeyboardDispatcher.detach(listener) }
    instrumentation.waitForIdleSync()
  }

  @Test fun physicalEnterAfterComposingWordSubmitsOnceAndKeepsTheWord() = onMain {
    assertTrue(dispatch(KeyEvent.ACTION_DOWN))
    assertTrue("A held key repeats without submitting again", dispatch(KeyEvent.ACTION_DOWN, repeat = 1))
    assertTrue(dispatch(KeyEvent.ACTION_UP))

    assertEquals(1, presses.size)
    assertEquals(SubmitKeyPress(COMPOSER_ID, ctrlKey = false, metaKey = false), presses.single())
    assertEquals("тест", composer.text.toString())
    assertEquals("The composing region is finished", -1, composingStart())
  }

  @Test fun ctrlEnterReportsCtrlForTheAlternateAction() = onMain {
    assertTrue(dispatch(KeyEvent.ACTION_DOWN, meta = KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON))
    assertTrue(dispatch(KeyEvent.ACTION_UP))
    assertEquals(SubmitKeyPress(COMPOSER_ID, ctrlKey = true, metaKey = false), presses.single())
  }

  @Test fun shiftEnterPassesThroughAndKeepsComposing() = onMain {
    val shift = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
    assertFalse(dispatch(KeyEvent.ACTION_DOWN, meta = shift))
    assertFalse(dispatch(KeyEvent.ACTION_UP, meta = shift))
    assertTrue(presses.isEmpty())
    assertEquals(0, composingStart())
  }

  @Test fun softKeyboardEnterPassesThroughAndKeepsComposing() = onMain {
    val soft = KeyEvent.FLAG_SOFT_KEYBOARD or KeyEvent.FLAG_KEEP_TOUCH_MODE
    assertFalse(dispatch(KeyEvent.ACTION_DOWN, device = KeyCharacterMap.VIRTUAL_KEYBOARD, flags = soft))
    assertFalse(dispatch(KeyEvent.ACTION_UP, device = KeyCharacterMap.VIRTUAL_KEYBOARD, flags = soft))
    // An IME-sent Enter from the virtual keyboard without the soft flag is not physical either.
    assertFalse(dispatch(KeyEvent.ACTION_DOWN, device = KeyCharacterMap.VIRTUAL_KEYBOARD))
    assertFalse(dispatch(KeyEvent.ACTION_UP, device = KeyCharacterMap.VIRTUAL_KEYBOARD))
    assertTrue(presses.isEmpty())
    assertEquals(0, composingStart())
  }

  @Test fun enterInAnotherFocusedFieldPassesThrough() = onMain {
    val other = EditText(instrumentation.targetContext)
    other.onCreateInputConnection(EditorInfo())!!.setComposingText("word", 1)
    assertFalse(PaseoHardwareKeyboardDispatcher.dispatchEnterKey(other, key(KeyEvent.ACTION_DOWN)))
    assertFalse(PaseoHardwareKeyboardDispatcher.dispatchEnterKey(other, key(KeyEvent.ACTION_UP)))
    assertTrue(presses.isEmpty())
    assertEquals(0, BaseInputConnection.getComposingSpanStart(other.text))
  }

  private fun onMain(check: () -> Unit) = instrumentation.runOnMainSync { check() }

  private fun dispatch(
    action: Int,
    repeat: Int = 0,
    meta: Int = 0,
    device: Int = PHYSICAL_KEYBOARD_ID,
    flags: Int = 0,
  ) = PaseoHardwareKeyboardDispatcher.dispatchEnterKey(composer, key(action, repeat, meta, device, flags))

  private fun key(
    action: Int,
    repeat: Int = 0,
    meta: Int = 0,
    device: Int = PHYSICAL_KEYBOARD_ID,
    flags: Int = 0,
  ): KeyEvent {
    val now = SystemClock.uptimeMillis()
    return KeyEvent(now, now, action, KeyEvent.KEYCODE_ENTER, repeat, meta, device, 0, flags, InputDevice.SOURCE_KEYBOARD)
  }

  private fun composingStart() = BaseInputConnection.getComposingSpanStart(composer.text)
}
