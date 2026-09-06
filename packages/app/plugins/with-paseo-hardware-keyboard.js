const { withMainActivity } = require("expo/config-plugins");

// Routes hardware key events through PaseoHardwareKeyboardKeyDispatcher before
// the focused view sees them. Activity-level onKeyDown (which Expo's
// ReactActivityHandler exposes) never fires for keys a focused text input
// consumes — Enter in particular — so the override must be at dispatch level.
const DISPATCH_OVERRIDE = `
  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    if (expo.modules.paseohardwarekeyboard.PaseoHardwareKeyboardKeyDispatcher.dispatchKeyEvent(event)) {
      return true
    }
    return super.dispatchKeyEvent(event)
  }
`;

function withPaseoHardwareKeyboard(config) {
  return withMainActivity(config, (modConfig) => {
    if (modConfig.modResults.language !== "kt") {
      throw new Error("with-paseo-hardware-keyboard requires a Kotlin MainActivity");
    }
    const contents = modConfig.modResults.contents;
    if (!contents.includes("PaseoHardwareKeyboardKeyDispatcher")) {
      const patched = contents.replace(/\n}\s*$/, `\n${DISPATCH_OVERRIDE}}\n`);
      if (patched === contents) {
        throw new Error("with-paseo-hardware-keyboard could not find MainActivity closing brace");
      }
      modConfig.modResults.contents = patched;
    }
    return modConfig;
  });
}

module.exports = withPaseoHardwareKeyboard;
