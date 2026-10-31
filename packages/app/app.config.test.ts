import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

describe("Android bundled monospace fonts", () => {
  it("packages all four React Native styles without changing unrelated assets", async () => {
    const { copyAndroidMonospaceFonts } = require("./plugins/with-android-monospace");
    const androidRoot = await mkdtemp(path.join(tmpdir(), "paseo-monospace-"));
    try {
      await copyAndroidMonospaceFonts({ projectRoot: __dirname, platformProjectRoot: androidRoot });
      const fonts = path.join(androidRoot, "app/src/main/assets/fonts");
      await writeFile(path.join(fonts, "unrelated.ttf"), "unrelated asset");
      await writeFile(path.join(fonts, "monospace.ttf"), "stale build");
      await copyAndroidMonospaceFonts({ projectRoot: __dirname, platformProjectRoot: androidRoot });
      expect((await readdir(fonts)).sort()).toEqual([
        "RobotoMono-OFL.txt",
        "monospace.ttf",
        "monospace_bold.ttf",
        "monospace_bold_italic.ttf",
        "monospace_italic.ttf",
        "unrelated.ttf",
      ]);
      const variants = [
        ["monospace.ttf", "RobotoMono-Regular.ttf"],
        ["monospace_bold.ttf", "RobotoMono-Bold.ttf"],
        ["monospace_italic.ttf", "RobotoMono-Italic.ttf"],
        ["monospace_bold_italic.ttf", "RobotoMono-BoldItalic.ttf"],
        ["RobotoMono-OFL.txt", "OFL.txt"],
      ];
      for (const [asset, source] of variants) {
        expect(await readFile(path.join(fonts, asset))).toEqual(
          await readFile(path.join(__dirname, "assets/fonts/roboto-mono", source)),
        );
      }
      expect(await readFile(path.join(fonts, "unrelated.ttf"), "utf8")).toBe("unrelated asset");
    } finally {
      await rm(androidRoot, { recursive: true, force: true });
    }
  });

  it("fails prebuild when the bundled font is missing", async () => {
    const { copyAndroidMonospaceFonts } = require("./plugins/with-android-monospace");
    const projectRoot = await mkdtemp(path.join(tmpdir(), "paseo-missing-font-"));
    try {
      await expect(
        copyAndroidMonospaceFonts({
          projectRoot,
          platformProjectRoot: path.join(projectRoot, "android"),
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function resolveAndroidManifest() {
  const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["android"] });
  await compileModsAsync(exp, {
    projectRoot: __dirname,
    introspect: true,
    platforms: ["android"],
    assertMissingModProviders: false,
  });
  return exp._internal.modResults.android.manifest.manifest;
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
      const manifest = await resolveAndroidManifest();
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
});

it("follows system rotation on Android", async () => {
  const manifest = await resolveAndroidManifest();
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
