import { describe, expect, it } from "vitest";
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
});
