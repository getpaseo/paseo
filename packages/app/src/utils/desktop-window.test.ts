import { describe, expect, it } from "vitest";
import {
  intersectWindowChromeCorners,
  resolveChildWindowChromeCorners,
  resolveHasOwnedWindowChromeObstruction,
  resolveWindowChromeObstruction,
  resolveWindowChromeSafeArea,
} from "@/utils/desktop-window";

describe("window chrome", () => {
  it("has no corner obstruction outside Electron or in fullscreen", () => {
    expect(
      resolveWindowChromeObstruction({ mode: null, isFullscreen: false, topBand: null }),
    ).toEqual({
      topLeft: null,
      topRight: null,
    });
    expect(
      resolveWindowChromeObstruction({ mode: "native-mac", isFullscreen: true, topBand: null }),
    ).toEqual({
      topLeft: null,
      topRight: null,
    });
  });

  it("places native controls in their physical top corner", () => {
    expect(
      resolveWindowChromeObstruction({ mode: "native-mac", isFullscreen: false, topBand: null }),
    ).toEqual({
      topLeft: { width: 78, height: 45 },
      topRight: null,
    });
    expect(
      resolveWindowChromeObstruction({
        mode: "custom-windows",
        isFullscreen: false,
        topBand: null,
      }),
    ).toEqual({ topLeft: null, topRight: { width: 138, height: 36 } });
    expect(
      resolveWindowChromeObstruction({ mode: "custom-linux", isFullscreen: false, topBand: null }),
    ).toEqual({
      topLeft: null,
      topRight: { width: 108, height: 36 },
    });
  });

  // Measured: iPhone Duo inner screen, portrait. The top bar ends at x 525, where the status
  // region (0..82) starts; the band starts at y 26.
  it("treats the status region beside a native top band as top-right window controls", () => {
    expect(
      resolveWindowChromeObstruction({
        mode: null,
        isFullscreen: false,
        topBand: { top: 26, trailingObstruction: { width: 144, height: 56 } },
      }),
    ).toEqual({ topLeft: null, topRight: { width: 144, height: 56 } });
    expect(
      resolveWindowChromeObstruction({
        mode: null,
        isFullscreen: false,
        topBand: { top: 26, trailingObstruction: null },
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

it("assigns window buttons only to exposed split edges", () => {
  expect(
    resolveChildWindowChromeCorners({
      corners: "both",
      direction: "horizontal",
      isFirst: true,
      isLast: false,
    }),
  ).toBe("top-left");
  expect(
    resolveChildWindowChromeCorners({
      corners: "both",
      direction: "horizontal",
      isFirst: false,
      isLast: true,
    }),
  ).toBe("top-right");
  expect(
    resolveChildWindowChromeCorners({
      corners: "both",
      direction: "horizontal",
      isFirst: false,
      isLast: false,
    }),
  ).toBe("none");
  expect(
    resolveChildWindowChromeCorners({
      corners: "both",
      direction: "vertical",
      isFirst: true,
      isLast: false,
    }),
  ).toBe("both");
  expect(
    resolveChildWindowChromeCorners({
      corners: "both",
      direction: "vertical",
      isFirst: false,
      isLast: true,
    }),
  ).toBe("none");
  expect(
    resolveChildWindowChromeCorners({
      corners: "top-right",
      direction: "horizontal",
      isFirst: true,
      isLast: true,
    }),
  ).toBe("top-right");
});
