const fs = require("node:fs");
const path = require("node:path");
const {
  IOSConfig,
  withAppDelegate,
  withDangerousMod,
  withPodfile,
} = require("expo/config-plugins");

const MODULE_SETUP = "    PasteInputModule.setup(factory.rootViewFactory)";
const REACT_NATIVE_START_END = "      launchOptions: launchOptions)\n#endif";
const BRIDGING_HEADER_IMPORT = "#import <react-native-paste-input/PasteInputModule.h>";
const PODFILE_NEW_ARCH_DISABLED =
  "ENV['RCT_NEW_ARCH_ENABLED'] ||= '0' if podfile_properties['newArchEnabled'] == 'false'";
const PODFILE_NEW_ARCH_ENABLED =
  "ENV['RCT_NEW_ARCH_ENABLED'] ||= '1' if podfile_properties['newArchEnabled'] == 'true'";

function configurePasteInputAppDelegate(contents) {
  const configured = contents.replace(`\n${MODULE_SETUP}`, "");
  if (!configured.includes(REACT_NATIVE_START_END)) {
    throw new Error("Could not register paste input after React Native starts");
  }
  return configured.replace(
    REACT_NATIVE_START_END,
    `      launchOptions: launchOptions)\n${MODULE_SETUP}\n#endif`,
  );
}

function configurePasteInputBridgingHeader(contents) {
  if (contents.includes(BRIDGING_HEADER_IMPORT)) {
    return contents;
  }
  return `${contents.trimEnd()}\n${BRIDGING_HEADER_IMPORT}\n`;
}

function configurePasteInputPodfile(contents) {
  if (contents.includes(PODFILE_NEW_ARCH_ENABLED)) {
    return contents;
  }
  if (!contents.includes(PODFILE_NEW_ARCH_DISABLED)) {
    throw new Error("Could not configure the new architecture for paste input");
  }
  return contents.replace(
    PODFILE_NEW_ARCH_DISABLED,
    `${PODFILE_NEW_ARCH_DISABLED}\n${PODFILE_NEW_ARCH_ENABLED}`,
  );
}

function withPasteInput(config) {
  const withDelegate = withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== "swift") {
      throw new Error("Paste input setup requires a Swift AppDelegate");
    }
    modConfig.modResults.contents = configurePasteInputAppDelegate(modConfig.modResults.contents);
    return modConfig;
  });
  const withPods = withPodfile(withDelegate, (modConfig) => {
    modConfig.modResults.contents = configurePasteInputPodfile(modConfig.modResults.contents);
    return modConfig;
  });
  return withPasteInputBridgingHeader(withPods);
}

function withPasteInputBridgingHeader(config) {
  return withDangerousMod(config, [
    "ios",
    async (modConfig) => {
      const projectRoot = modConfig.modRequest.projectRoot;
      const sourceRoot = IOSConfig.Paths.getSourceRoot(projectRoot);
      const projectName = IOSConfig.XcodeUtils.getProjectName(projectRoot);
      const headerPath = path.join(sourceRoot, `${projectName}-Bridging-Header.h`);
      const contents = fs.readFileSync(headerPath, "utf8");
      fs.writeFileSync(headerPath, configurePasteInputBridgingHeader(contents));
      return modConfig;
    },
  ]);
}

module.exports = withPasteInput;
module.exports.configurePasteInputAppDelegate = configurePasteInputAppDelegate;
module.exports.configurePasteInputBridgingHeader = configurePasteInputBridgingHeader;
module.exports.configurePasteInputPodfile = configurePasteInputPodfile;
