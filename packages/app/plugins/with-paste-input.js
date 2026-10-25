const fs = require("node:fs");
const path = require("node:path");
const {
  IOSConfig,
  withAppDelegate,
  withDangerousMod,
  withInfoPlist,
  withPodfile,
} = require("expo/config-plugins");

const BRIDGING_HEADER_IMPORT = "#import <react-native-paste-input/PasteInputModule.h>";
const SCENE_DELEGATE = `
@objc(PaseoSceneDelegate)
class PaseoSceneDelegate: ExpoAppSceneDelegate {
  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    super.scene(scene, willConnectTo: session, options: connectionOptions)
    guard let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
      let factory = provider.reactNativeFactory else { return }
    PasteInputModule.setup(factory.rootViewFactory)
  }
}
`;

function configurePasteInputAppDelegate(contents) {
  if (contents.includes("class PaseoSceneDelegate:")) return contents;
  if (!contents.includes("ExpoReactNativeFactoryProvider")) {
    throw new Error("Paste input requires Expo scene support");
  }
  return `${contents.trimEnd()}\n${SCENE_DELEGATE}`;
}

function configurePasteInputBridgingHeader(contents) {
  if (contents.includes(BRIDGING_HEADER_IMPORT)) {
    return contents;
  }
  return `${contents.trimEnd()}\n${BRIDGING_HEADER_IMPORT}\n`;
}

function withPasteInput(config) {
  const withDelegate = withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== "swift") {
      throw new Error("Paste input setup requires a Swift AppDelegate");
    }
    modConfig.modResults.contents = configurePasteInputAppDelegate(modConfig.modResults.contents);
    return modConfig;
  });
  const withScene = withInfoPlist(withDelegate, (modConfig) => {
    const scenes =
      modConfig.modResults.UIApplicationSceneManifest?.UISceneConfigurations
        ?.UIWindowSceneSessionRoleApplication;
    if (!scenes || scenes.length !== 1) {
      throw new Error("Paste input requires Expo's single scene configuration");
    }
    scenes[0].UISceneDelegateClassName = "PaseoSceneDelegate";
    return modConfig;
  });
  const withPods = withPodfile(withScene, (modConfig) => {
    // Paste input checks this legacy flag even though RN 0.86 only supports Fabric.
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

function configurePasteInputPodfile(contents) {
  const flag = "ENV['RCT_NEW_ARCH_ENABLED'] = '1'";
  return contents.includes(flag) ? contents : `${flag}\n${contents}`;
}
module.exports.configurePasteInputPodfile = configurePasteInputPodfile;
