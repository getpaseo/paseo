import { getConfig } from "@expo/config";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("native orientation configuration", () => {
  const { exp } = getConfig(path.resolve(import.meta.dirname, ".."));

  it("lets Android choose the full display window before runtime orientation policy applies", () => {
    expect(exp.orientation).toBe("default");
  });

  it("keeps the iPhone portrait orientations explicit while iPad supports rotation", () => {
    expect(exp.ios?.infoPlist?.UISupportedInterfaceOrientations).toEqual([
      "UIInterfaceOrientationPortrait",
      "UIInterfaceOrientationPortraitUpsideDown",
    ]);
    expect(exp.ios?.supportsTablet).toBe(true);
  });
});
