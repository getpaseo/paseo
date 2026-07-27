import { describe, expect, it } from "vitest";
import { getFdroidVersionCodes, getNativeBuildVersionCode } from "~android-version-codes";
import { getAndroidVersionCode } from "./android-version";

describe("getAndroidVersionCode", () => {
  it("matches the Android build version code for a stable release", () => {
    expect(getAndroidVersionCode("0.1.107")).toBe(1107);
  });

  it("rejects versions that cannot map to a unique Android version code", () => {
    expect(() => getAndroidVersionCode("0.1000.0")).toThrow(
      "Cannot derive collision-free Android versionCode from version: 0.1000.0",
    );
  });

  // The endpoint is a public contract, and the F-Droid build stamps a *different*
  // (per-ABI) code into its APKs. Pin which of the two /android-version.txt serves.
  it("serves the base version code, not a per-ABI F-Droid code", () => {
    expect(getAndroidVersionCode("0.2.2")).toBe(getNativeBuildVersionCode("0.2.2"));
    expect(getAndroidVersionCode("0.2.2")).toBe(2002);

    const fdroidCodes = getFdroidVersionCodes("0.2.2").map((entry) => entry.versionCode);
    expect(fdroidCodes).not.toContain(getAndroidVersionCode("0.2.2"));
  });

  it("ignores prerelease metadata", () => {
    expect(getAndroidVersionCode("0.2.3-beta.1")).toBe(getAndroidVersionCode("0.2.3"));
  });
});
