import { describe, expect, it } from "vitest";
import { detectBrowserDeviceType } from "./browser-device-type";

describe("detectBrowserDeviceType", () => {
  it("returns mobile for common mobile user agents", () => {
    expect(
      detectBrowserDeviceType({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
      }),
    ).toBe("mobile");

    expect(
      detectBrowserDeviceType({
        userAgent:
          "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/135.0 Mobile Safari/537.36",
      }),
    ).toBe("mobile");
  });

  it("returns mobile for iPadOS desktop-class Safari", () => {
    expect(
      detectBrowserDeviceType({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 5,
      }),
    ).toBe("mobile");
  });

  it("returns web for desktop-class browsers", () => {
    expect(
      detectBrowserDeviceType({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/135.0 Safari/537.36",
        platform: "MacIntel",
        maxTouchPoints: 0,
      }),
    ).toBe("web");

    expect(
      detectBrowserDeviceType({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/135.0 Safari/537.36",
        platform: "Linux x86_64",
        maxTouchPoints: 0,
      }),
    ).toBe("web");
  });
});
