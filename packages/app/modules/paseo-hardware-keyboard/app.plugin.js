const { withMainActivity } = require("expo/config-plugins");

const MARKER = "sh.paseo.hardwarekeyboard.PaseoHardwareKeyboardDispatcher.dispatchKeyEvent";
const CLASS_DECLARATION = /^class MainActivity : ReactActivity\(\) \{$/m;
const DISPATCH_OVERRIDE = `
  // Hardware keyboard Enter reaches the composer's Enter rules before ReactEditText.
  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    if (${MARKER}(this, event)) return true
    return super.dispatchKeyEvent(event)
  }
`;

function configureMainActivity(contents, language) {
  if (contents.includes(MARKER)) return contents;
  if (language !== "kt") {
    throw new Error(
      "Could not intercept Android hardware keyboard submit: MainActivity is not Kotlin",
    );
  }
  if (/\bfun dispatchKeyEvent\(/.test(contents)) {
    throw new Error(
      "Could not intercept Android hardware keyboard submit: MainActivity already overrides dispatchKeyEvent",
    );
  }
  if (!CLASS_DECLARATION.test(contents)) {
    throw new Error(
      "Could not intercept Android hardware keyboard submit: MainActivity template changed",
    );
  }
  return contents.replace(CLASS_DECLARATION, (declaration) => `${declaration}${DISPATCH_OVERRIDE}`);
}

module.exports = (config) =>
  withMainActivity(config, (mod) => {
    mod.modResults.contents = configureMainActivity(
      mod.modResults.contents,
      mod.modResults.language,
    );
    return mod;
  });
module.exports.configureMainActivity = configureMainActivity;
