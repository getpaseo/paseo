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
      resolveWindowChromeObstruction({ isElectron: false, isMac: true, isFullscreen: false }),
    ).toEqual({ topLeft: null, topRight: null });
    expect(
      resolveWindowChromeObstruction({ isElectron: true, isMac: true, isFullscreen: true }),
    ).toEqual({ topLeft: null, topRight: null });
  });

  it("places native controls in their physical top corner", () => {
    expect(
      resolveWindowChromeObstruction({ isElectron: true, isMac: true, isFullscreen: false }),
    ).toEqual({ topLeft: { width: 78, height: 45 }, topRight: null });
    expect(
      resolveWindowChromeObstruction({ isElectron: true, isMac: false, isFullscreen: false }),
    ).toEqual({ topLeft: null, topRight: { width: 140, height: 48 } });
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
