const { withAndroidManifest } = require("expo/config-plugins");

function withAndroidFoldConfiguration(config) {
  return withAndroidManifest(config, (modConfig) => {
    const activity = modConfig.modResults.manifest.application?.[0]?.activity?.find(
      (entry) => entry.$?.["android:name"] === ".MainActivity",
    );
    if (!activity) {
      throw new Error("Could not configure fold changes without MainActivity");
    }

    // A fold changes smallestScreenWidthDp as well as screenSize. Let React Native and
    // Unistyles receive the configuration change without Android recreating MainActivity.
    const changes = new Set((activity.$["android:configChanges"] ?? "").split("|").filter(Boolean));
    changes.add("smallestScreenSize");
    activity.$["android:configChanges"] = [...changes].join("|");
    return modConfig;
  });
}

module.exports = withAndroidFoldConfiguration;
