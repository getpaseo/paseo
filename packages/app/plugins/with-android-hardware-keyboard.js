const { withMainActivity } = require("expo/config-plugins");

const KEYBOARD_HANDLER = `
  // Physical Enter submits only the focused Paseo composer. IME and Shift+Enter
  // retain Android's text editing behavior.
  private var paseoEnterConsumed = false

  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    if (event.keyCode != android.view.KeyEvent.KEYCODE_ENTER &&
        event.keyCode != android.view.KeyEvent.KEYCODE_NUMPAD_ENTER) {
      return super.dispatchKeyEvent(event)
    }
    if (event.action == android.view.KeyEvent.ACTION_UP && paseoEnterConsumed) {
      paseoEnterConsumed = false
      return true
    }
    if (event.action != android.view.KeyEvent.ACTION_DOWN) {
      return super.dispatchKeyEvent(event)
    }
    if (paseoEnterConsumed) return true
    if (event.deviceId <= 0 ||
        event.flags and android.view.KeyEvent.FLAG_SOFT_KEYBOARD != 0 ||
        !event.hasNoModifiers() || event.repeatCount != 0) {
      return super.dispatchKeyEvent(event)
    }
    val input = currentFocus as? com.facebook.react.views.textinput.ReactEditText
      ?: return super.dispatchKeyEvent(event)
    if (android.view.inputmethod.BaseInputConnection.getComposingSpanStart(input.text) >= 0) {
      return super.dispatchKeyEvent(event)
    }
    val context = input.context as? com.facebook.react.bridge.ReactContext
      ?: return super.dispatchKeyEvent(event)
    var ancestor: android.view.View? = input
    while (ancestor != null) {
      if (ancestor.getTag(com.facebook.react.R.id.react_test_id) == "message-input-root") {
        paseoEnterConsumed = true
        context.emitDeviceEvent("paseoHardwareKeyboardSubmit")
        return true
      }
      ancestor = ancestor.parent as? android.view.View
    }
    return super.dispatchKeyEvent(event)
  }
`;

function configureHardwareKeyboardActivity(contents) {
  if (contents.includes("private var paseoEnterConsumed")) return contents;
  if (!/class MainActivity\b/.test(contents) || contents.lastIndexOf("}") < 0) {
    throw new Error("Could not locate Kotlin MainActivity for hardware keyboard setup");
  }
  if (/override fun dispatchKeyEvent\s*\(/.test(contents)) {
    throw new Error(
      "MainActivity already overrides dispatchKeyEvent; merge keyboard handling first",
    );
  }
  const end = contents.lastIndexOf("}");
  return contents.slice(0, end) + KEYBOARD_HANDLER + contents.slice(end);
}

function withAndroidHardwareKeyboard(config) {
  return withMainActivity(config, (modConfig) => {
    if (modConfig.modResults.language !== "kt") {
      throw new Error("Hardware keyboard setup requires a Kotlin MainActivity");
    }
    modConfig.modResults.contents = configureHardwareKeyboardActivity(
      modConfig.modResults.contents,
    );
    return modConfig;
  });
}

module.exports = withAndroidHardwareKeyboard;
module.exports.configureHardwareKeyboardActivity = configureHardwareKeyboardActivity;
