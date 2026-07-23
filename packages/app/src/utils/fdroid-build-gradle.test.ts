import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const { configureFdroidAppBuildGradle } = require("../../plugins/with-fdroid-autolinking.js") as {
  configureFdroidAppBuildGradle: (contents: string) => string;
};

describe("F-Droid Android build configuration", () => {
  test("assigns ordered version-code suffixes to single-ABI builds", () => {
    const buildGradle = configureFdroidAppBuildGradle("android {\n}\n");

    expect(buildGradle).toContain('"armeabi-v7a": 1');
    expect(buildGradle).toContain('"arm64-v8a": 2');
    expect(buildGradle).toContain('"x86": 3');
    expect(buildGradle).toContain('"x86_64": 4');
    expect(buildGradle).toContain(
      "android.defaultConfig.versionCode = android.defaultConfig.versionCode * 10 + paseoAbiVersionCode",
    );
  });

  test("keeps repeated Expo prebuilds idempotent", () => {
    const firstBuildGradle = configureFdroidAppBuildGradle("android {\n}\n");

    expect(configureFdroidAppBuildGradle(firstBuildGradle)).toBe(firstBuildGradle);
  });
});
