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

it("allows Android tablets to rotate without a portrait manifest lock", async () => {
  const manifest = await resolveAndroidManifest();
  const activity = manifest.application[0].activity.find(
    (entry: ManifestEntry) => entry.$["android:name"] === ".MainActivity",
  );
  expect(activity.$["android:screenOrientation"]).toBe("@integer/paseo_orientation");
}, 30_000);

it("generates portrait phone and unrestricted tablet orientation resources", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "paseo-orientation-"));
  try {
    const plugin = createRequire(import.meta.url)("./plugins/with-android-orientation.js");
    const config = plugin({ name: "test", slug: "test" });
    await config.mods.android.dangerous({
      modRequest: { platformProjectRoot: root },
      modResults: {},
    });
    const resource = (directory: string) =>
      readFile(join(root, "app/src/main/res", directory, "paseo_orientation.xml"), "utf8");
    expect(await resource("values")).toContain('name="paseo_orientation">1</integer>');
    expect(await resource("values-sw600dp")).toContain('name="paseo_orientation">-1</integer>');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("updates the native orientation before launch and when screen size changes", async () => {
  const plugin = createRequire(import.meta.url)("./plugins/with-android-orientation.js");
  const config = plugin({ name: "test", slug: "test" });
  const result = await config.mods.android.mainActivity({
    modRequest: {},
    modResults: {
      language: "kt",
      contents:
        "class MainActivity {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    super.onCreate(null)\n  }\n}",
    },
  });
  expect(result.modResults.contents).toContain("smallestScreenWidthDp >= 600");
  expect(result.modResults.contents).toContain("SCREEN_ORIENTATION_UNSPECIFIED");
  expect(result.modResults.contents).toContain("SCREEN_ORIENTATION_PORTRAIT");
  expect(result.modResults.contents).toContain(
    "updateOrientation(resources.configuration)\n    super.onCreate(null)",
  );
  expect(result.modResults.contents).toContain("updateOrientation(newConfig)");
});
