import { describe, expect, it } from "vitest";
import { detectPlatform } from "./platform";

const AGENTS = {
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
};

describe("detectPlatform", () => {
  it.each([
    [AGENTS.android, "android"],
    [AGENTS.iphone, "ios"],
    [AGENTS.windows, "windows"],
    [AGENTS.linux, "linux"],
    [AGENTS.mac, "mac"],
  ])("resolves %s to %s", (userAgent, expected) => {
    expect(detectPlatform(userAgent)).toBe(expected);
  });

  it("prefers the mobile OS over the kernel or vendor the same agent also claims", () => {
    // Android agents say "Linux" and iOS ones say "like Mac OS X", so a
    // desktop-first check hands a phone a .dmg or an AppImage.
    expect(detectPlatform(AGENTS.android)).not.toBe("linux");
    expect(detectPlatform(AGENTS.iphone)).not.toBe("mac");
  });

  it("falls back to mac for an unknown user agent", () => {
    expect(detectPlatform("")).toBe("mac");
  });
});
