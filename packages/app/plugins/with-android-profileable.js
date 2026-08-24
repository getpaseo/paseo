const { withAndroidManifest } = require("expo/config-plugins");

function withAndroidProfileable(config) {
  return withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("Could not enable Android profiling without an application manifest entry");
    }

    application.profileable = [{ $: { "android:shell": "true" } }];
    return modConfig;
  });
}

module.exports = withAndroidProfileable;
