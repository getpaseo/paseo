import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

// Load the copies the Expo CLI uses for prebuild, not older hoisted ones.
const requireFromExpo = createRequire(require.resolve("expo/package.json"));
const requireFromExpoCli = createRequire(requireFromExpo.resolve("@expo/cli/package.json"));
const { getPrebuildConfigAsync } = requireFromExpoCli("@expo/prebuild-config");
const { compileModsAsync } = requireFromExpoCli(
  "@expo/config-plugins/build/plugins/mod-compiler.js",
);

interface ManifestEntry {
  $: Record<string, string>;
}

const originalFdroidFlag = process.env.PASEO_FDROID_BUILD;

async function resolveAndroidMods() {
  const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["android"] });
  await compileModsAsync(exp, {
    projectRoot: __dirname,
    introspect: true,
    platforms: ["android"],
    assertMissingModProviders: false,
  });
  return exp._internal.modResults.android;
}

describe("Android app config", () => {
  afterEach(() => {
    if (originalFdroidFlag === undefined) {
      delete process.env.PASEO_FDROID_BUILD;
    } else {
      process.env.PASEO_FDROID_BUILD = originalFdroidFlag;
    }
  });

  it.each([
    ["Google Play", "0"],
    ["F-Droid", "1"],
  ])(
    "%s build installs on devices without a camera",
    async (_build, fdroidFlag) => {
      process.env.PASEO_FDROID_BUILD = fdroidFlag;
      const manifest = (await resolveAndroidMods()).manifest.manifest;
      const permissions = (manifest["uses-permission"] ?? []).map(
        (entry: ManifestEntry) => entry.$["android:name"],
      );
      const features = (manifest["uses-feature"] ?? []).map((entry: ManifestEntry) => entry.$);

      expect(permissions).toContain("android.permission.CAMERA");
      expect(features).toEqual(
        expect.arrayContaining([
          { "android:name": "android.hardware.camera", "android:required": "false" },
          { "android:name": "android.hardware.camera.autofocus", "android:required": "false" },
        ]),
      );
    },
    30_000,
  );

  it.each([
    ["Google Play", "0"],
    ["F-Droid", "1"],
  ])(
    "%s release enables code and resource shrinking through prebuild",
    async (_build, fdroidFlag) => {
      process.env.PASEO_FDROID_BUILD = fdroidFlag;
      const android = await resolveAndroidMods();

      expect(android.gradleProperties).toEqual(
        expect.arrayContaining([
          { type: "property", key: "android.enableMinifyInReleaseBuilds", value: "true" },
          { type: "property", key: "android.enableShrinkResourcesInReleaseBuilds", value: "true" },
        ]),
      );
    },
    30_000,
  );
});

it("follows system rotation on Android", async () => {
  const manifest = (await resolveAndroidMods()).manifest.manifest;
  const activity = manifest.application[0].activity.find(
    (entry: ManifestEntry) => entry.$["android:name"] === ".MainActivity",
  );
  expect(activity.$["android:screenOrientation"]).toBe("unspecified");
}, 30_000);

it("allows all orientations on iPhone and iPad", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "paseo-ios-config-"));
  try {
    const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["ios"] });
    await compileModsAsync(exp, {
      projectRoot: root,
      introspect: true,
      platforms: ["ios"],
      assertMissingModProviders: false,
    });
    const plist = exp._internal.modResults.ios.infoPlist;
    const orientations = [
      "UIInterfaceOrientationPortrait",
      "UIInterfaceOrientationPortraitUpsideDown",
      "UIInterfaceOrientationLandscapeLeft",
      "UIInterfaceOrientationLandscapeRight",
    ];
    expect(plist.UISupportedInterfaceOrientations).toEqual(orientations);
    expect(plist["UISupportedInterfaceOrientations~ipad"]).toEqual(orientations);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

// Scene startup is the integration boundary for the iOS keyboard window.
describe("hardware keyboard scene integration", () => {
  it("installs observation after Expo creates the scene window and is idempotent", () => {
    const {
      configureHardwareKeyboardAppDelegate,
    } = require("./modules/paseo-hardware-keyboard/app.plugin.js");
    const source =
      "import Expo\nclass Scene {\n  super.scene(scene, willConnectTo: session, options: connectionOptions)\n}\n";
    const configured = configureHardwareKeyboardAppDelegate(source);
    expect(configured).toContain("import PaseoHardwareKeyboard");
    expect(configured).toContain("PaseoHardwareKeyboardWindow.observing(window)");
    expect(configured.indexOf("super.scene")).toBeLessThan(
      configured.indexOf(".observing(window)"),
    );
    expect(configureHardwareKeyboardAppDelegate(configured)).toBe(configured);
  });
});

// Android Bold text bolds unstyled text at draw time after React Native measured it
// unbolded, which clips trailing words (#4057, #10152, #10850). The activity must opt out
// with a sparse Configuration() so other configuration fields still update live.
describe("Android Bold text opt-out", () => {
  const {
    configureIgnoreBoldTextMainActivity,
  } = require("./plugins/with-android-ignore-bold-text.js");
  const {
    configureDisplayMetricsActivity,
  } = require("./modules/paseo-display-metrics/app.plugin.js");
  const mainActivity = [
    "package sh.paseo",
    "import expo.modules.splashscreen.SplashScreenManager",
    "",
    "import android.os.Build",
    "import android.os.Bundle",
    "",
    "import com.facebook.react.ReactActivity",
    "",
    "class MainActivity : ReactActivity() {",
    "  override fun onCreate(savedInstanceState: Bundle?) {",
    "    super.onCreate(null)",
    "  }",
    "}",
    "",
  ].join("\n");

  it("zeroes fontWeightAdjustment on a sparse Configuration before attaching and is idempotent", () => {
    const configured = configureIgnoreBoldTextMainActivity(mainActivity);
    expect(configured).toMatch(/^import android\.content\.Context$/m);
    expect(configured).toMatch(/^import android\.content\.res\.Configuration$/m);
    expect(configured).toContain("override fun attachBaseContext(newBase: Context)");
    expect(configured).toContain("val override = Configuration()");
    expect(configured).not.toContain("Configuration(configuration)");
    expect(configured).toContain("override.fontWeightAdjustment = 0");
    expect(configured).toContain(
      "super.attachBaseContext(newBase.createConfigurationContext(override))",
    );
    expect(configured.indexOf("attachBaseContext")).toBeLessThan(configured.indexOf("onCreate"));
    expect(configureIgnoreBoldTextMainActivity(configured)).toBe(configured);
  });

  it("composes cleanly with withAndroidDisplayMetrics in both plugin orders", () => {
    const displayFirst = configureIgnoreBoldTextMainActivity(
      configureDisplayMetricsActivity(mainActivity),
    );
    const boldFirst = configureDisplayMetricsActivity(
      configureIgnoreBoldTextMainActivity(mainActivity),
    );

    for (const configured of [displayFirst, boldFirst]) {
      expect(configured).toContain("override fun attachBaseContext(newBase: Context)");
      expect(configured).toContain("val override = Configuration()");
      expect(configured).toContain("override.fontWeightAdjustment = 0");
      expect(configured).toContain("override fun onContentChanged()");
      expect(configured).toContain(
        "override fun onConfigurationChanged(newConfig: android.content.res.Configuration)",
      );
      expect(configured).toContain(
        "sh.paseo.displaymetrics.PaseoDisplayMetrics.syncWithWindow(this)",
      );
      expect(configureIgnoreBoldTextMainActivity(configured)).toBe(configured);
      expect(configureDisplayMetricsActivity(configured)).toBe(configured);
    }
  });

  it("fails the prebuild when the MainActivity template changes shape", () => {
    expect(() => configureIgnoreBoldTextMainActivity("package sh.paseo\n")).toThrow(
      /MainActivity class declaration/,
    );
  });

  it("fails the prebuild rather than duplicate an existing attachBaseContext override", () => {
    const withExistingOverride = mainActivity.replace(
      "override fun onCreate",
      "override fun attachBaseContext(newBase: Context) { super.attachBaseContext(newBase) }\n\n  override fun onCreate",
    );
    expect(() => configureIgnoreBoldTextMainActivity(withExistingOverride)).toThrow(
      /existing attachBaseContext override/,
    );
  });

  it("is registered in the app config", async () => {
    const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["android"] });
    // Expo records function plugins by name.
    expect(exp.plugins).toContain("withAndroidIgnoreBoldText");
  }, 30_000);
});
