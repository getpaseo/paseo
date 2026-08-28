/**
 * Widget extension that hosts the Paseo fleet-mode Live Activity.
 *
 * `ios/` is CNG output, so this directory is the repo-owned source for the
 * extension: @bacons/apple-targets links every file here into the generated
 * Xcode project on each `expo prebuild`.
 *
 * No `entitlements` block on purpose. Live Activities need no App Group, and
 * declaring one would add a provisioning requirement for nothing.
 *
 * @type {import('@bacons/apple-targets/app.plugin').Config}
 */
module.exports = {
  type: "widget",
  name: "PaseoLiveActivity",
  displayName: "Paseo Live Activity",
  // Appended to the main app's bundle identifier, so it tracks the app variant.
  bundleIdentifier: ".liveactivity",
  // ActivityKit's `ActivityContent` / `ActivityUIDismissalPolicy` API is 16.2.
  deploymentTarget: "16.2",
  frameworks: ["ActivityKit", "WidgetKit", "SwiftUI"],
};
