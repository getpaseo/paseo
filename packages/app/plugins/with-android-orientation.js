const { withMainActivity } = require("expo/config-plugins");

module.exports = function withAndroidOrientation(config) {
  return withMainActivity(config, (mod) => {
    const activity = mod.modResults;
    if (activity.language !== "kt") throw new Error("Expected Kotlin MainActivity");
    const marker = "  // Paseo orientation policy";
    if (!activity.contents.includes(marker)) {
      const anchor = "  override fun onCreate(savedInstanceState: Bundle?)";
      if (!activity.contents.includes(anchor)) throw new Error("MainActivity anchor missing");
      activity.contents = activity.contents.replace(
        anchor,
        `${marker}
  private fun updateOrientation(configuration: android.content.res.Configuration) {
    val orientation = if (configuration.smallestScreenWidthDp >= 600)
      android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    else
      android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    if (requestedOrientation != orientation) requestedOrientation = orientation
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    updateOrientation(newConfig)
  }

${anchor}`,
      );
      if (!activity.contents.includes("    super.onCreate(null)"))
        throw new Error("MainActivity onCreate missing");
      activity.contents = activity.contents.replace(
        "    super.onCreate(null)",
        "    updateOrientation(resources.configuration)\n    super.onCreate(null)",
      );
    }
    return mod;
  });
};
