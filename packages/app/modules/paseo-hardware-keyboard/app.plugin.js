const { withAppDelegate } = require("expo/config-plugins");
const SCENE_START = "super.scene(scene, willConnectTo: session, options: connectionOptions)";

function configureHardwareKeyboardAppDelegate(source) {
  source = source.replace(
    /^import PaseoHardwareKeyboard$/m,
    "internal import PaseoHardwareKeyboard",
  );
  if (source.includes("PaseoHardwareKeyboardWindow.observing(window)")) return source;
  if (!source.includes(SCENE_START)) {
    throw new Error("Hardware keyboard observation requires the app's Expo scene delegate");
  }
  const installation = `${SCENE_START}
    if let window {
      let observedWindow = PaseoHardwareKeyboardWindow.observing(window)
      self.window = observedWindow
      (UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider)?.window = observedWindow
    }`;
  return "internal import PaseoHardwareKeyboard\n" + source.replace(SCENE_START, installation);
}
module.exports = function withHardwareKeyboardWindow(config) {
  return withAppDelegate(config, (modConfig) => {
    modConfig.modResults.contents = configureHardwareKeyboardAppDelegate(
      modConfig.modResults.contents,
    );
    return modConfig;
  });
};
module.exports.configureHardwareKeyboardAppDelegate = configureHardwareKeyboardAppDelegate;
