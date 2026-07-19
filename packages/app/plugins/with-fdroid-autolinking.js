const fs = require("node:fs/promises");
const path = require("node:path");
const { withAppBuildGradle, withDangerousMod, withSettingsGradle } = require("expo/config-plugins");

const EXCLUDED_ANDROID_MODULES = [
  "expo-camera",
  "expo-notifications",
  "expo-dev-client",
  "expo-dev-launcher",
  "expo-dev-menu",
  "expo-dev-menu-interface",
];

function withFdroidAutolinking(config) {
  config = withDangerousMod(config, [
    "android",
    async (modConfig) => {
      const packageJsonPath = path.join(modConfig.modRequest.projectRoot, "package.json");
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
      const expo = packageJson.expo ?? {};
      const autolinking = expo.autolinking ?? {};
      const android = autolinking.android ?? {};
      const fdroidPackageJson = {
        ...packageJson,
        expo: {
          ...expo,
          autolinking: {
            ...autolinking,
            android: {
              ...android,
              buildFromSource: [".*"],
              exclude: EXCLUDED_ANDROID_MODULES,
            },
          },
        },
      };
      const overlayRoot = path.join(modConfig.modRequest.platformProjectRoot, "fdroid-autolinking");

      await fs.mkdir(overlayRoot, { recursive: true });
      await fs.writeFile(
        path.join(overlayRoot, "package.json"),
        `${JSON.stringify(fdroidPackageJson, null, 2)}\n`,
      );
      return modConfig;
    },
  ]);

  config = withSettingsGradle(config, (modConfig) => {
    const fdroidProjectRoot =
      'expoAutolinking.projectRoot = new File(rootDir, "fdroid-autolinking")';
    if (modConfig.modResults.contents.includes(fdroidProjectRoot)) {
      return modConfig;
    }

    const useExpoModules = "expoAutolinking.useExpoModules()";
    if (!modConfig.modResults.contents.includes(useExpoModules)) {
      throw new Error("Could not configure F-Droid Expo autolinking in settings.gradle");
    }

    modConfig.modResults.contents = modConfig.modResults.contents.replace(
      useExpoModules,
      `${fdroidProjectRoot}\n${useExpoModules}`,
    );
    return modConfig;
  });

  return withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.contents.includes("dependenciesInfo {")) {
      return modConfig;
    }

    const androidBlock = "android {";
    if (!modConfig.modResults.contents.includes(androidBlock)) {
      throw new Error("Could not disable F-Droid dependency metadata in app/build.gradle");
    }

    modConfig.modResults.contents = modConfig.modResults.contents.replace(
      androidBlock,
      `${androidBlock}\n    dependenciesInfo {\n        includeInApk = false\n        includeInBundle = false\n    }`,
    );
    return modConfig;
  });
}

module.exports = withFdroidAutolinking;
