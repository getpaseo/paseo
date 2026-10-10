const { withAndroidManifest } = require("expo/config-plugins");

// Requesting CAMERA implies these features are required, which hides the app
// on Google Play for devices without a camera. Pairing works without QR scanning.
const OPTIONAL_CAMERA_FEATURES = ["android.hardware.camera", "android.hardware.camera.autofocus"];

function withAndroidOptionalCamera(config) {
  return withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;
    const features = manifest["uses-feature"] ?? [];
    for (const name of OPTIONAL_CAMERA_FEATURES) {
      const existing = features.find((feature) => feature.$["android:name"] === name);
      if (existing) {
        existing.$["android:required"] = "false";
      } else {
        features.push({ $: { "android:name": name, "android:required": "false" } });
      }
    }
    manifest["uses-feature"] = features;
    return modConfig;
  });
}

module.exports = withAndroidOptionalCamera;
