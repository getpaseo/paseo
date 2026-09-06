/**
 * Wrapper around @bacons/apple-targets that makes incremental iOS prebuild idempotent.
 *
 * Upstream @bacons/apple-targets@4.0.7 crashes on the second `expo prebuild` when a
 * widget target already exists: its update path calls
 * `buildConfigurationList.getReferrers().forEach(ref => ref.removeReference(...))`,
 * which clears the target's configuration-list reference, then invokes
 * `removeFromProject()` on the now-undefined list (GitHub EvanBacon/expo-apple-targets#201).
 *
 * v5.0.0 targets Expo SDK 55, so SDK 54 needs this narrow workaround: register a
 * pre-sync mod immediately before the xcodeProjectBeta2 base provider and remove the
 * Live Activity extension target so upstream always takes the working create path.
 */
const fs = require("fs");
const path = require("path");
const { PBXNativeTarget } = require("@bacons/xcode");
const withWidget = require("@bacons/apple-targets/build/with-widget").default;
const { withPodTargetExtension } = require("@bacons/apple-targets/build/with-pod-target-extension");
const {
  withXcodeProjectBeta,
  withXcodeProjectBetaBaseMod,
} = require("@bacons/apple-targets/build/with-bacons-xcode");
const { warnOnce } = require("@bacons/apple-targets/build/util");

/** Must match `name` in targets/paseo-live-activity/expo-target.config.js. */
const LIVE_ACTIVITY_TARGET_NAME = "PaseoLiveActivity";

/**
 * @param {string} projectRoot
 * @param {string} root
 * @param {string} match
 * @returns {string[]}
 */
function findTargetConfigPaths(projectRoot, root, match) {
  const targetsRoot = path.join(projectRoot, root);
  if (!fs.existsSync(targetsRoot)) {
    return [];
  }

  const configs = [];
  for (const entry of fs.readdirSync(targetsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (match !== "*" && entry.name !== match) {
      continue;
    }
    for (const fileName of ["expo-target.config.js", "expo-target.config.json"]) {
      const configPath = path.join(targetsRoot, entry.name, fileName);
      if (fs.existsSync(configPath)) {
        configs.push(configPath);
      }
    }
  }
  return configs;
}

/**
 * @param {import('@bacons/xcode').XcodeProject} project
 */
function removeExistingLiveActivityTarget(project) {
  const existingTarget = project.rootObject.props.targets.find(
    (target) =>
      PBXNativeTarget.is(target) && target.props.productName === LIVE_ACTIVITY_TARGET_NAME,
  );

  if (existingTarget) {
    existingTarget.removeFromProject();
  }
}

/**
 * Same as @bacons/apple-targets/build/config-plugin, plus the incremental-prebuild fix.
 *
 * @type {import('expo/config-plugins').ConfigPlugin<{ root?: string; match?: string; appleTeamId?: string } | void>}
 */
function withPaseoAppleTargets(config, props) {
  let { appleTeamId = config.ios?.appleTeamId } = props ?? {};
  const { root = "./targets", match = "*" } = props ?? {};
  const projectRoot = config._internal.projectRoot;

  if (!config.ios?.bundleIdentifier) {
    const fallbackBundleId = `com.example.${config.slug}`;
    warnOnce(
      `[bacons/apple-targets] Expo config is missing ios.bundleIdentifier property. Using fallback: ${fallbackBundleId}. Add it to your app.json or app.config.js for production builds.`,
    );
    config.ios = config.ios ?? {};
    config.ios.bundleIdentifier = fallbackBundleId;
  }

  if (!appleTeamId) {
    warnOnce(
      "[bacons/apple-targets] Expo config is missing required ios.appleTeamId property. Find this in Xcode and add to the Expo Config to correct. iOS builds may fail until this is corrected.",
    );
  }

  const targets = findTargetConfigPaths(projectRoot, root, match);

  for (const configPath of targets) {
    const targetConfig = require(configPath);
    let evaluatedTargetConfigObject = targetConfig;

    if (typeof targetConfig === "function") {
      evaluatedTargetConfigObject = targetConfig(config);
      if (typeof evaluatedTargetConfigObject !== "object") {
        throw new Error(
          `Expected target config function to return an object, but got ${typeof evaluatedTargetConfigObject}`,
        );
      }
    } else if (typeof targetConfig !== "object") {
      throw new Error(
        `Expected target config to be an object or function that returns an object, but got ${typeof targetConfig}`,
      );
    }

    if (!evaluatedTargetConfigObject.type) {
      throw new Error(
        "Expected target config to have a 'type' property denoting the type of target it is, e.g. 'widget'",
      );
    }

    config = withWidget(config, {
      appleTeamId,
      ...evaluatedTargetConfigObject,
      directory: path.relative(projectRoot, path.dirname(configPath)),
      configPath,
    });
  }

  withPodTargetExtension(config);

  // Runs after upstream widget mods register but before the base provider is sealed.
  // Mod chain executes in reverse registration order, so this runs before applyXcodeChanges.
  config = withXcodeProjectBeta(config, (pluginConfig) => {
    removeExistingLiveActivityTarget(pluginConfig.modResults);
    return pluginConfig;
  });

  withXcodeProjectBetaBaseMod(config);
  return config;
}

module.exports = withPaseoAppleTargets;
