const { withAndroidManifest, withMainActivity, withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

module.exports = function withAndroidOrientation(config) {
  // The manifest locks phones before the first activity frame. Tablets start unlocked.
  config = withAndroidManifest(config, (mod) => {
    const activity = mod.modResults.manifest.application[0].activity.find(
      (item) => item.$["android:name"] === ".MainActivity",
    );
    activity.$["android:screenOrientation"] = "@integer/paseo_orientation";
    return mod;
  });
  config = withMainActivity(config, (mod) => {
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
  return withDangerousMod(config, [
    "android",
    async (mod) => {
      const res = path.join(mod.modRequest.platformProjectRoot, "app/src/main/res");
      // ActivityInfo uses 1 for portrait and -1 for unspecified.
      for (const [dir, value] of [
        ["values", "1"],
        ["values-sw600dp", "-1"],
      ]) {
        const target = path.join(res, dir);
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(
          path.join(target, "paseo_orientation.xml"),
          `<resources><integer name="paseo_orientation">${value}</integer></resources>\n`,
        );
      }
      return mod;
    },
  ]);
};
