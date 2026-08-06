package expo.modules.paseohardwarekeyboard

import android.content.Context
import android.hardware.input.InputManager
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val HARDWARE_SUBMIT_EVENT_NAME = "onHardwareKeyboardSubmit"
private const val HARDWARE_KEY_DOWN_EVENT_NAME = "onHardwareKeyDown"
private const val HARDWARE_MODIFIER_EVENT_NAME = "onHardwareModifier"
private const val HARDWARE_CONNECTION_EVENT_NAME = "onHardwareKeyboardConnectionChange"

class PaseoHardwareKeyboardModule : Module() {
  private var inputManager: InputManager? = null

  private val inputDeviceListener = object : InputManager.InputDeviceListener {
    override fun onInputDeviceAdded(deviceId: Int) = emitConnectionState()
    override fun onInputDeviceRemoved(deviceId: Int) = emitConnectionState()
    override fun onInputDeviceChanged(deviceId: Int) = emitConnectionState()
  }

  override fun definition() = ModuleDefinition {
    Name("PaseoHardwareKeyboard")

    Events(
      HARDWARE_SUBMIT_EVENT_NAME,
      HARDWARE_KEY_DOWN_EVENT_NAME,
      HARDWARE_MODIFIER_EVENT_NAME,
      HARDWARE_CONNECTION_EVENT_NAME,
    )

    OnCreate {
      PaseoHardwareKeyboardKeyDispatcher.module = this@PaseoHardwareKeyboardModule
      inputManager =
        appContext.reactContext?.getSystemService(Context.INPUT_SERVICE) as? InputManager
      inputManager?.registerInputDeviceListener(inputDeviceListener, null)
    }

    Function("setHardwareKeyboardSubmitEnabled") { enabled: Boolean ->
      PaseoHardwareKeyboardKeyDispatcher.isSubmitEnabled = enabled
    }

    Function("setHardwareKeyEventsEnabled") { enabled: Boolean ->
      PaseoHardwareKeyboardKeyDispatcher.isKeyEventsEnabled = enabled
    }

    Function("getHardwareKeyboardConnected") {
      isHardwareKeyboardConnected()
    }

    OnDestroy {
      if (PaseoHardwareKeyboardKeyDispatcher.module === this@PaseoHardwareKeyboardModule) {
        PaseoHardwareKeyboardKeyDispatcher.module = null
      }
      PaseoHardwareKeyboardKeyDispatcher.isSubmitEnabled = false
      PaseoHardwareKeyboardKeyDispatcher.isKeyEventsEnabled = false
      inputManager?.unregisterInputDeviceListener(inputDeviceListener)
      inputManager = null
    }
  }

  internal fun emitHardwareKeyboardSubmit(alternate: Boolean) {
    sendEvent(HARDWARE_SUBMIT_EVENT_NAME, mapOf("alternate" to alternate))
  }

  internal fun emitHardwareKeyDown(payload: Map<String, Any>) {
    sendEvent(HARDWARE_KEY_DOWN_EVENT_NAME, payload)
  }

  internal fun emitHardwareModifier(key: String, down: Boolean) {
    sendEvent(HARDWARE_MODIFIER_EVENT_NAME, mapOf("key" to key, "down" to down))
  }

  private fun emitConnectionState() {
    sendEvent(HARDWARE_CONNECTION_EVENT_NAME, mapOf("connected" to isHardwareKeyboardConnected()))
  }

  private fun isHardwareKeyboardConnected(): Boolean {
    return InputDevice.getDeviceIds().any { deviceId ->
      val device = InputDevice.getDevice(deviceId) ?: return@any false
      !device.isVirtual &&
        device.supportsSource(InputDevice.SOURCE_KEYBOARD) &&
        device.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC
    }
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
    val module = this.module ?: return false
    // Soft keyboards deliver their return key as a virtual-device key event.
    // Those must reach the text input as a newline — the on-screen send button
    // is how touch users submit.
    if (!isFromHardwareKeyboard(event)) {
      return false
    }

    val modifier = modifierName(event.keyCode)
    if (modifier != null) {
      if (isKeyEventsEnabled && event.repeatCount == 0) {
        when (event.action) {
          KeyEvent.ACTION_DOWN -> module.emitHardwareModifier(modifier, true)
          KeyEvent.ACTION_UP -> module.emitHardwareModifier(modifier, false)
        }
      }
      return false
    }

    if (event.action != KeyEvent.ACTION_DOWN) {
      return false
    }

    val ctrlKey = event.isCtrlPressed
    val altKey = event.isAltPressed
    val metaKey = event.isMetaPressed
    val shiftKey = event.isShiftPressed

    // Matches desktop: Enter sends, Ctrl/Cmd+Enter takes the alternate send
    // (queue while the agent runs), Shift+Enter falls through as a newline.
    // Consume the ones we act on so the text input doesn't also insert one.
    if (isSubmitEnabled && event.keyCode == KeyEvent.KEYCODE_ENTER && !shiftKey && !altKey) {
      if (ctrlKey || metaKey) {
        module.emitHardwareKeyboardSubmit(true)
        return true
      }
      module.emitHardwareKeyboardSubmit(false)
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
        "repeat" to (event.repeatCount > 0),
      )
    )
    // Never consumed: text inputs ignore unknown modifier combos, and consuming
    // here would break EditText combos the registry doesn't use (Ctrl+A/C/V/X/Z).
    return false
  }

  private fun isFromHardwareKeyboard(event: KeyEvent): Boolean {
    if (event.deviceId == KeyCharacterMap.VIRTUAL_KEYBOARD) return false
    val device = event.device ?: return false
    return !device.isVirtual
  }

  private fun modifierName(keyCode: Int): String? {
    return when (keyCode) {
      KeyEvent.KEYCODE_ALT_LEFT, KeyEvent.KEYCODE_ALT_RIGHT -> "Alt"
      KeyEvent.KEYCODE_CTRL_LEFT, KeyEvent.KEYCODE_CTRL_RIGHT -> "Control"
      KeyEvent.KEYCODE_META_LEFT, KeyEvent.KEYCODE_META_RIGHT -> "Meta"
      KeyEvent.KEYCODE_SHIFT_LEFT, KeyEvent.KEYCODE_SHIFT_RIGHT -> "Shift"
      else -> null
    }
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
