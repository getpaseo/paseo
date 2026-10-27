import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

// Load the copies the Expo CLI uses for prebuild, not older hoisted ones.
const requireFromExpo = createRequire(require.resolve("expo/package.json"));
const requireFromExpoCli = createRequire(requireFromExpo.resolve("@expo/cli/package.json"));
const { getPrebuildConfigAsync } = requireFromExpoCli("@expo/prebuild-config");
const { getConfig } = requireFromExpoCli("@expo/config");
const { compileModsAsync } = requireFromExpoCli(
  "@expo/config-plugins/build/plugins/mod-compiler.js",
);

interface ManifestEntry {
  $: Record<string, string>;
}

const originalFdroidFlag = process.env.PASEO_FDROID_BUILD;

describe("Personal development app config", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps personal push settings out of production builds", () => {
    vi.stubEnv("APP_VARIANT", "production");
    vi.stubEnv("PASEO_DEV_IOS_BUNDLE_IDENTIFIER", "com.example.paseo.dev");
    vi.stubEnv("PASEO_DEV_EAS_PROJECT_ID", "personal-project");
    vi.stubEnv("PASEO_DEV_EXPO_OWNER", "personal-owner");
    vi.stubEnv("PASEO_DEV_EXPO_SLUG", "personal-slug");

    const { exp } = getConfig(__dirname, { skipPlugins: true });

    expect(exp.ios.bundleIdentifier).toBe("sh.paseo");
    expect(exp.extra.eas.projectId).toBe("0e7f65ce-0367-46c8-a238-2b65963d235a");
    expect(exp.owner).toBe("getpaseo");
    expect(exp.slug).toBe("voice-mobile");
    expect(exp.name).toBe("Paseo");
    expect(exp.icon).toBe("./assets/images/icon.png");
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
