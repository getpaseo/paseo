package expo.modules.paseohardwarekeyboard

import android.view.KeyEvent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val HARDWARE_SUBMIT_EVENT_NAME = "onHardwareKeyboardSubmit"
private const val HARDWARE_KEY_DOWN_EVENT_NAME = "onHardwareKeyDown"

class PaseoHardwareKeyboardModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoHardwareKeyboard")

    Events(HARDWARE_SUBMIT_EVENT_NAME, HARDWARE_KEY_DOWN_EVENT_NAME)

    OnCreate {
      PaseoHardwareKeyboardKeyDispatcher.module = this@PaseoHardwareKeyboardModule
    }

    Function("setHardwareKeyboardSubmitEnabled") { enabled: Boolean ->
      PaseoHardwareKeyboardKeyDispatcher.isSubmitEnabled = enabled
    }

    Function("setHardwareKeyEventsEnabled") { enabled: Boolean ->
      PaseoHardwareKeyboardKeyDispatcher.isKeyEventsEnabled = enabled
    }

    OnDestroy {
      if (PaseoHardwareKeyboardKeyDispatcher.module === this@PaseoHardwareKeyboardModule) {
        PaseoHardwareKeyboardKeyDispatcher.module = null
      }
      PaseoHardwareKeyboardKeyDispatcher.isSubmitEnabled = false
      PaseoHardwareKeyboardKeyDispatcher.isKeyEventsEnabled = false
    }
  }

  internal fun emitHardwareKeyboardSubmit() {
    sendEvent(HARDWARE_SUBMIT_EVENT_NAME)
  }

  internal fun emitHardwareKeyDown(payload: Map<String, Any>) {
    sendEvent(HARDWARE_KEY_DOWN_EVENT_NAME, payload)
  }
}

/**
 * Called from MainActivity.dispatchKeyEvent (injected by
 * plugins/with-paseo-hardware-keyboard.js). Activity-level onKeyDown never
 * fires for keys a focused text input consumes (Enter in particular), so
 * interception has to happen at dispatch level.
 */
object PaseoHardwareKeyboardKeyDispatcher {
  @Volatile internal var module: PaseoHardwareKeyboardModule? = null
  @Volatile internal var isSubmitEnabled = false
  @Volatile internal var isKeyEventsEnabled = false

  @JvmStatic
  fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.action != KeyEvent.ACTION_DOWN) {
      return false
    }
    val module = this.module ?: return false

    val ctrlKey = event.isCtrlPressed
    val altKey = event.isAltPressed
    val metaKey = event.isMetaPressed
    val shiftKey = event.isShiftPressed

    // Shift+Enter sends the composer message. Consume it so the focused text
    // input doesn't also insert a newline.
    if (
      isSubmitEnabled &&
      event.keyCode == KeyEvent.KEYCODE_ENTER &&
      shiftKey && !ctrlKey && !altKey && !metaKey
    ) {
      module.emitHardwareKeyboardSubmit()
      return true
    }

    if (!isKeyEventsEnabled) {
      return false
    }
    val code = domCode(event.keyCode) ?: return false
    val isFunctionKey = event.keyCode in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12
    val isShortcutWorthy = ctrlKey || altKey || metaKey || code == "Escape" || isFunctionKey
    if (!isShortcutWorthy) {
      return false
    }

    module.emitHardwareKeyDown(
      mapOf(
        "code" to code,
        "metaKey" to metaKey,
        "ctrlKey" to ctrlKey,
        "altKey" to altKey,
        "shiftKey" to shiftKey,
      )
    )
    // Never consumed: text inputs ignore unknown modifier combos, and consuming
    // here would break EditText combos the registry doesn't use (Ctrl+A/C/V/X/Z).
    return false
  }

  private fun domCode(keyCode: Int): String? {
    if (keyCode in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z) {
      return "Key" + ('A' + (keyCode - KeyEvent.KEYCODE_A))
    }
    if (keyCode in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9) {
      return "Digit" + (keyCode - KeyEvent.KEYCODE_0)
    }
    if (keyCode in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12) {
      return "F" + (keyCode - KeyEvent.KEYCODE_F1 + 1)
    }
    return when (keyCode) {
      KeyEvent.KEYCODE_ENTER -> "Enter"
      KeyEvent.KEYCODE_ESCAPE -> "Escape"
      KeyEvent.KEYCODE_DEL -> "Backspace"
      KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
      KeyEvent.KEYCODE_TAB -> "Tab"
      KeyEvent.KEYCODE_SPACE -> "Space"
      KeyEvent.KEYCODE_MINUS -> "Minus"
      KeyEvent.KEYCODE_EQUALS -> "Equal"
      KeyEvent.KEYCODE_LEFT_BRACKET -> "BracketLeft"
      KeyEvent.KEYCODE_RIGHT_BRACKET -> "BracketRight"
      KeyEvent.KEYCODE_BACKSLASH -> "Backslash"
      KeyEvent.KEYCODE_SEMICOLON -> "Semicolon"
      KeyEvent.KEYCODE_APOSTROPHE -> "Quote"
      KeyEvent.KEYCODE_GRAVE -> "Backquote"
      KeyEvent.KEYCODE_COMMA -> "Comma"
      KeyEvent.KEYCODE_PERIOD -> "Period"
      KeyEvent.KEYCODE_SLASH -> "Slash"
      KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
      KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
      KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
      KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
      KeyEvent.KEYCODE_MOVE_HOME -> "Home"
      KeyEvent.KEYCODE_MOVE_END -> "End"
      KeyEvent.KEYCODE_PAGE_UP -> "PageUp"
      KeyEvent.KEYCODE_PAGE_DOWN -> "PageDown"
      else -> null
    }
  }
}
