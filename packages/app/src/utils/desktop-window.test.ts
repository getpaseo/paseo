import { describe, expect, it } from "vitest";
import {
  intersectWindowChromeCorners,
  resolveHasOwnedWindowChromeObstruction,
  resolveWindowChromeObstruction,
  resolveWindowChromeSafeArea,
} from "@/utils/desktop-window";

describe("window chrome", () => {
  it("has no corner obstruction outside Electron or in fullscreen", () => {
    expect(
      resolveWindowChromeObstruction({
        isElectron: false,
        isMac: true,
        isFullscreen: false,
        measurement: null,
      }),
    ).toEqual({ topLeft: null, topRight: null });
    expect(
      resolveWindowChromeObstruction({
        isElectron: true,
        isMac: true,
        isFullscreen: true,
        measurement: null,
      }),
    ).toEqual({ topLeft: null, topRight: null });
  });

  it("places native controls in their physical top corner", () => {
    expect(
      resolveWindowChromeObstruction({
        isElectron: true,
        isMac: true,
        isFullscreen: false,
        measurement: null,
      }),
    ).toEqual({ topLeft: { width: 78, height: 45 }, topRight: null });
    expect(
      resolveWindowChromeObstruction({
        isElectron: true,
        isMac: false,
        isFullscreen: false,
        measurement: null,
      }),
    ).toEqual({ topLeft: null, topRight: { width: 140, height: 29 } });
  });

  it("clears corner obstructions when fullscreen wins over a visible measurement", () => {
    expect(
      resolveWindowChromeObstruction({
        isElectron: true,
        isMac: false,
        isFullscreen: true,
        measurement: { visible: true, insets: { leftWidth: 0, rightWidth: 140, height: 29 } },
      }),
    ).toEqual({ topLeft: null, topRight: null });
    expect(
      resolveWindowChromeObstruction({
        isElectron: false,
        isMac: false,
        isFullscreen: false,
        measurement: { visible: true, insets: { leftWidth: 0, rightWidth: 140, height: 29 } },
      }),
    ).toEqual({ topLeft: null, topRight: null });
  });

  it("clears corner obstructions when overlay measurement is explicitly not visible", () => {
    expect(
      resolveWindowChromeObstruction({
        isElectron: true,
        isMac: false,
        isFullscreen: false,
        measurement: { visible: false },
      }),
    ).toEqual({ topLeft: null, topRight: null });
    expect(
      resolveWindowChromeObstruction({
        isElectron: true,
        isMac: true,
        isFullscreen: false,
        measurement: { visible: false },
      }),
    ).toEqual({ topLeft: null, topRight: null });
  });

  it("overrides hardcoded constants with measured geometry on non-mac", () => {
    expect(
      resolveWindowChromeObstruction({
        isElectron: true,
        isMac: false,
        isFullscreen: false,
        measurement: { visible: true, insets: { leftWidth: 0, rightWidth: 138, height: 30 } },
      }),
    ).toEqual({ topLeft: null, topRight: { width: 138, height: 30 } });
  });

  it("yields a top-left obstruction for measured left-side controls on non-mac", () => {
    expect(
      resolveWindowChromeObstruction({
        isElectron: true,
        isMac: false,
        isFullscreen: false,
        measurement: { visible: true, insets: { leftWidth: 120, rightWidth: 0, height: 30 } },
      }),
    ).toEqual({ topLeft: { width: 120, height: 30 }, topRight: null });
  });

  it("yields both corner obstructions when measured controls exist on both sides", () => {
    expect(
      resolveWindowChromeObstruction({
        isElectron: true,
        isMac: false,
        isFullscreen: false,
        measurement: { visible: true, insets: { leftWidth: 100, rightWidth: 140, height: 29 } },
      }),
    ).toEqual({ topLeft: { width: 100, height: 29 }, topRight: { width: 140, height: 29 } });
  });

  it("yields no obstructions when measured insets have zero width", () => {
    expect(
      resolveWindowChromeObstruction({
        isElectron: true,
        isMac: false,
        isFullscreen: false,
        measurement: { visible: true, insets: { leftWidth: 0, rightWidth: 0, height: 29 } },
      }),
    ).toEqual({ topLeft: null, topRight: null });
  });

  it("insets and reserves only claimed corners", () => {
    const obstruction = { topLeft: { width: 80, height: 28 }, topRight: { width: 48, height: 32 } };
    expect(
      resolveWindowChromeSafeArea({ obstruction, corners: "top-left", placement: "inline" }),
    ).toEqual({ paddingLeft: 80, paddingRight: 0 });
    expect(
      resolveWindowChromeSafeArea({ obstruction, corners: "top-right", placement: "below" }),
    ).toEqual({ height: 32 });
    expect(
      resolveWindowChromeSafeArea({ obstruction, corners: "both", placement: "below" }),
    ).toEqual({ height: 32 });
    expect(
      resolveWindowChromeSafeArea({ obstruction, corners: "top-right", placement: "inline" }),
    ).toEqual({ paddingLeft: 0, paddingRight: 48 });
  });

  it("intersects identical and empty corner claims", () => {
    expect(intersectWindowChromeCorners("both", "both")).toBe("both");
    expect(intersectWindowChromeCorners("top-left", "top-left")).toBe("top-left");
    expect(intersectWindowChromeCorners("none", "both")).toBe("none");
    expect(intersectWindowChromeCorners("both", "none")).toBe("none");
    expect(intersectWindowChromeCorners("both", "top-left")).toBe("top-left");
    expect(intersectWindowChromeCorners("top-right", "both")).toBe("top-right");
    expect(intersectWindowChromeCorners("top-left", "top-right")).toBe("none");
  });

  it("reports an obstruction only when the surface owns its corner", () => {
    const obstruction = {
      topLeft: { width: 78, height: 45 },
      topRight: { width: 140, height: 48 },
    };

    expect(
      resolveHasOwnedWindowChromeObstruction({
        obstruction,
        corners: "top-left",
        corner: "top-left",
      }),
    ).toBe(true);
    expect(
      resolveHasOwnedWindowChromeObstruction({
        obstruction,
        corners: "top-left",
        corner: "top-right",
      }),
    ).toBe(false);
    expect(
      resolveHasOwnedWindowChromeObstruction({
        obstruction: { topLeft: null, topRight: null },
        corners: "both",
        corner: "top-right",
      }),
    ).toBe(false);
  });
});
