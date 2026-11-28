const path = require("node:path");
const { makeMetroConfig } = require("@react-native-gpui/core/metro.config");
const projectRoot = path.resolve(__dirname, "..");
process.env.EXPO_ROUTER_APP_ROOT = path.resolve(projectRoot, "../src/app");
const config = makeMetroConfig({ projectRoot });
const resolveRequest = config.resolver.resolveRequest;
config.watchFolders.push(path.resolve(projectRoot, "../../.."));
config.transformer.unstable_allowRequireContext = true;
config.resolver.disableHierarchicalLookup = false;
config.resolver.blockList = /[/\\]gpui[/\\]desktop[/\\](target|build|autolink)[/\\]/;
// Metro loops over sourceExts outside platform suffixes, so listing gpui.<ext>
// first selects .gpui.* ahead of .desktop, .native, and base extensions.
config.resolver.sourceExts = [
  ...config.resolver.sourceExts.map((ext) => `gpui.${ext}`),
  ...config.resolver.sourceExts,
];
const nativePackages = [
  "react",
  "react-native-reanimated",
  "react-native-worklets",
  "react-native-gesture-handler",
  "react-native-screens",
  "react-native-safe-area-context",
  "react-native-svg",
];

const adapters = {
  "expo-keep-awake": "keep-awake.js",
  "expo-image-picker": "image-picker.js",
  "expo-image-manipulator": "image-manipulator.js",
  "expo-sharing": "sharing.js",
  "expo-document-picker": "document-picker.js",
  "@mattermost/react-native-paste-input": "paste-input.js",
  "@react-native-async-storage/async-storage": "async-storage.js",
  "expo-localization": "localization.js",
  "expo-clipboard": "clipboard.js",
  "expo-file-system": "file-system.js",
  "expo-file-system/legacy": "file-system.js",
  "react-native-keyboard-controller": "keyboard.jsx",
  crypto: "node-crypto.js",
  "node:crypto": "node-crypto.js",
  "expo-sqlite": "sqlite.js",
  "expo-crypto": "crypto.js",
  "react-native-unistyles": "unistyles.js",
};
config.resolver.resolveRequest = (context, name, platform) => {
  if (adapters[name]) name = path.resolve(projectRoot, "adapters", adapters[name]);
  if (
    name.endsWith("/ensureNativeModulesAreInstalled") &&
    context.originModulePath.includes("expo-modules-core")
  )
    name = path.resolve(projectRoot, "adapters/expo-install.js");
  if (name === "./ExpoLinking" && context.originModulePath.includes("expo-linking"))
    name = path.resolve(projectRoot, "adapters/expo-linking.js");
  // Linux has no Expo mobile push-token or camera provider; reuse the app's
  // existing unavailable-capability implementations.
  if (name === "expo-notifications")
    name = path.resolve(projectRoot, "../src/fdroid/expo-notifications.ts");
  if (name === "expo-camera") name = path.resolve(projectRoot, "../src/fdroid/expo-camera.tsx");
  if (name === "expo-router/_ctx") name = path.resolve(projectRoot, "routes.js");
  if (name === "qrcode") name = "qrcode/lib/browser.js";
  if (name.startsWith("react-native-unistyles/components/native/"))
    name = path.resolve(projectRoot, "adapters/unistyles-components.js");
  if (name.startsWith("@/")) name = path.resolve(projectRoot, "../src", name.slice(2));
  if (
    name.startsWith("react-native/") ||
    nativePackages.some((pkg) => name === pkg || name.startsWith(`${pkg}/`))
  ) {
    context = {
      ...context,
      disableHierarchicalLookup: true,
      nodeModulesPaths: [path.join(projectRoot, "node_modules")],
    };
  }
  return resolveRequest(context, name, platform);
};
module.exports = config;
