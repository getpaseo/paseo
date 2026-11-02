import { describe, expect, it } from "vitest";

const {
  configurePasteInputAppDelegate,
  configurePasteInputBridgingHeader,
  configurePasteInputPodfile,
} = require("./with-paste-input");

describe("withPasteInput", () => {
  it("registers paste input after Expo connects the React Native scene", () => {
    const source = "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {}";
    const configured = configurePasteInputAppDelegate(source);
    expect(configured).toContain("class PaseoSceneDelegate: ExpoAppSceneDelegate");
    expect(configured.indexOf("super.scene(")).toBeLessThan(
      configured.indexOf("PasteInputModule.setup("),
    );
    expect(configured).toContain("provider.reactNativeFactory");
    expect(configurePasteInputAppDelegate(configured)).toBe(configured);
  });

  it("exposes the Objective-C module to Swift through the bridging header", () => {
    const source = "// Swift bridging header\n";
    const configured = configurePasteInputBridgingHeader(source);

    expect(configured).toContain("#import <react-native-paste-input/PasteInputModule.h>");
    expect(configurePasteInputBridgingHeader(configured)).toBe(configured);
  });
  it("enables the legacy new-architecture flag required by the paste input podspec", () => {
    const source =
      "require File.join(File.dirname(`node --print \"require.resolve('expo/package.json')\"`), 'scripts/autolinking')";
    const configured = configurePasteInputPodfile(source);
    expect(configured).toBe("ENV['RCT_NEW_ARCH_ENABLED'] = '1'\n" + source);
    expect(configurePasteInputPodfile(configured)).toBe(configured);
  });
});
