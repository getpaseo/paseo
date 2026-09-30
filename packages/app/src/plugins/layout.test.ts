import { describe, expect, it } from "vitest";
import { createPluginLayout } from "./layout";

describe("plugin layout facts", () => {
  it("reports the platform family and a copy of the window insets", () => {
    const insets = { top: 47, bottom: 34, left: 0, right: 0 };
    const layout = createPluginLayout({ compact: true, os: "ios", insets });
    expect(layout).toEqual({ compact: true, platform: "ios", insets });
    expect(layout.insets).not.toBe(insets);
  });

  it("folds every non-mobile OS into web", () => {
    const insets = { top: 0, bottom: 0, left: 0, right: 0 };
    expect(createPluginLayout({ compact: false, os: "macos", insets }).platform).toBe("web");
    expect(createPluginLayout({ compact: false, os: "android", insets }).platform).toBe("android");
  });
});
