const { withMainActivity } = require("expo/config-plugins");

const MARKER = "// Paseo: rotate tablets, keep phones in portrait.";
const ORIENTATION = `${MARKER}
    requestedOrientation = if (resources.configuration.smallestScreenWidthDp >= 600) {
      android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    } else {
      android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    }
    `;

module.exports = function withAndroidTabletOrientation(config) {
  return withMainActivity(config, (modConfig) => {
    const activity = modConfig.modResults;
    if (activity.language !== "kt")
      throw new Error("Tablet orientation requires Kotlin MainActivity");
    if (activity.contents.includes(MARKER)) return modConfig;
    const before = activity.contents;
    activity.contents = before.replace(
      "super.onCreate(null)",
      `${ORIENTATION}super.onCreate(null)`,
    );
    if (activity.contents === before) throw new Error("MainActivity onCreate was not found");
    return modConfig;
  });
};
