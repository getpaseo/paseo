import { describe, expect, it } from "vitest";

const {
  configurePasteInputAppDelegate,
  configurePasteInputBridgingHeader,
  configurePasteInputPodfile,
} = require("./with-paste-input");

describe("withPasteInput", () => {
  it("registers the module after React Native starts", () => {
    const source = [
      "import ReactAppDependencyProvider",
      "",
      "    bindReactNativeFactory(factory)",
      "    factory.startReactNative(",
      '      withModuleName: "main",',
      "      in: window,",
      "      launchOptions: launchOptions)",
      "#endif",
    ].join("\n");
    const configured = configurePasteInputAppDelegate(source);

    expect(configured).toContain(
      "      launchOptions: launchOptions)\n    PasteInputModule.setup(factory.rootViewFactory)\n#endif",
    );
    expect(configurePasteInputAppDelegate(configured)).toBe(configured);
  });

  it("exposes the Objective-C module to Swift through the bridging header", () => {
    const source = "// Swift bridging header\n";
    const configured = configurePasteInputBridgingHeader(source);

    expect(configured).toContain("#import <react-native-paste-input/PasteInputModule.h>");
    expect(configurePasteInputBridgingHeader(configured)).toBe(configured);
  });

  it("sets the new architecture environment before CocoaPods evaluates dependencies", () => {
    const source =
      "ENV['RCT_NEW_ARCH_ENABLED'] ||= '0' if podfile_properties['newArchEnabled'] == 'false'";
    const configured = configurePasteInputPodfile(source);

    expect(configured).toContain(
      "ENV['RCT_NEW_ARCH_ENABLED'] ||= '1' if podfile_properties['newArchEnabled'] == 'true'",
    );
    expect(configurePasteInputPodfile(configured)).toBe(configured);
  });
});
