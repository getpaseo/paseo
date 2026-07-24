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

const FDROID_ABI_VERSION_CODE_BLOCK = `// Paseo F-Droid single-ABI version codes
def paseoAbiVersionCodes = [
    "armeabi-v7a": 1,
    "arm64-v8a": 2,
    "x86": 3,
    "x86_64": 4,
]
def paseoArchitectures = (findProperty("reactNativeArchitectures") ?: "")
    .toString()
    .split(",")
    .collect { it.trim() }
    .findAll { !it.isEmpty() }

if (paseoArchitectures.size() == 1) {
    def paseoAbi = paseoArchitectures[0]
    def paseoAbiVersionCode = paseoAbiVersionCodes[paseoAbi]
    if (paseoAbiVersionCode == null) {
        throw new GradleException("Unsupported Paseo Android ABI: " + paseoAbi)
    }
    android.defaultConfig.versionCode = android.defaultConfig.versionCode * 10 + paseoAbiVersionCode
}
`;

function configureFdroidAppBuildGradle(contents) {
  let configuredContents = contents;

  if (!configuredContents.includes("dependenciesInfo {")) {
    const androidBlock = "android {";
    if (!configuredContents.includes(androidBlock)) {
      throw new Error("Could not disable F-Droid dependency metadata in app/build.gradle");
    }

    configuredContents = configuredContents.replace(
      androidBlock,
      `${androidBlock}\n    dependenciesInfo {\n        includeInApk = false\n        includeInBundle = false\n    }`,
    );
  }

  if (!configuredContents.includes("// Paseo F-Droid single-ABI version codes")) {
    configuredContents = `${configuredContents.trimEnd()}\n\n${FDROID_ABI_VERSION_CODE_BLOCK}`;
  }

  return configuredContents;
}

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
    modConfig.modResults.contents = configureFdroidAppBuildGradle(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = withFdroidAutolinking;
