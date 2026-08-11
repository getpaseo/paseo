import { describe, expect, it } from "vitest";
import {
  intersectWindowChromeCorners,
  resolveWindowChromeObstruction,
  resolveWindowChromeRowPlacement,
  resolveWindowChromeSafeArea,
  resolveWindowControlsBackground,
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
    ).toEqual({ topLeft: null, topRight: { width: 140, height: 29 } });
  });

  it("keeps rows inline whenever no top-right control blocks them", () => {
    const mac = resolveWindowChromeObstruction({
      isElectron: true,
      isMac: true,
      isFullscreen: false,
    });
    const measured = {
      availableWidth: 400,
      contentWidth: 380,
      previousPlacement: "below" as const,
    };

    // Traffic lights lead the row, so macOS pads past them and never drops.
    expect(resolveWindowChromeRowPlacement({ obstruction: mac, ...measured })).toBe("inline");
    // Browser, native, and fullscreen have no controls, so they keep the inline row.
    expect(
      resolveWindowChromeRowPlacement({
        obstruction: { topLeft: null, topRight: null },
        ...measured,
      }),
    ).toBe("inline");
    expect(
      resolveWindowChromeRowPlacement({
        obstruction: resolveWindowChromeObstruction({
          isElectron: true,
          isMac: false,
          isFullscreen: true,
        }),
        ...measured,
      }),
    ).toBe("inline");
  });

  it("drops a top-right row below only when its content no longer fits beside the controls", () => {
    const windows = resolveWindowChromeObstruction({
      isElectron: true,
      isMac: false,
      isFullscreen: false,
    });
    const place = (availableWidth: number | null, contentWidth: number | null) =>
      resolveWindowChromeRowPlacement({
        obstruction: windows,
        availableWidth,
        contentWidth,
        previousPlacement: "inline",
      });

    // 140px of controls plus 200px of content leaves 60px spare — ample.
    expect(place(400, 200)).toBe("inline");
    // The same content in a 280px panel overflows by 60px.
    expect(place(280, 200)).toBe("below");
    // Stay inline until a measurement proves otherwise, so a wide row never drops on load.
    expect(place(null, 200)).toBe("inline");
    expect(place(400, null)).toBe("inline");
  });

  it("uses a wider margin to restore an inline row than to drop it", () => {
    const windows = resolveWindowChromeObstruction({
      isElectron: true,
      isMac: false,
      isFullscreen: false,
    });
    const place = (contentWidth: number, previousPlacement: "inline" | "below") =>
      resolveWindowChromeRowPlacement({
        obstruction: windows,
        availableWidth: 400,
        contentWidth,
        previousPlacement,
      });

    // 16px spare sits between the two margins: an inline row keeps its place...
    expect(place(244, "inline")).toBe("inline");
    // ...but a dropped row needs more than that before it climbs back up.
    expect(place(244, "below")).toBe("below");
    // Past the upper margin it restores.
    expect(place(220, "below")).toBe("inline");
    // Below the lower margin it drops.
    expect(place(256, "inline")).toBe("below");
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

  it("paints the native controls to match the surface that reaches the corner", () => {
    const colors = { sidebarColor: "#141716", contentColor: "#181b1a" };
    const windows = { isElectron: true, isMac: false, ...colors };

    // The explorer reaches the top-right corner while it is open, so the controls take its surface.
    expect(resolveWindowControlsBackground({ ...windows, isExplorerOpen: true })).toBe("#141716");
    // Closed, the content surface is what sits under them.
    expect(resolveWindowControlsBackground({ ...windows, isExplorerOpen: false })).toBe("#181b1a");
  });

  it("leaves the window controls alone where the app does not paint them", () => {
    const colors = { sidebarColor: "#141716", contentColor: "#181b1a" };

    // macOS draws its own traffic lights; opening the explorer must not repaint anything.
    expect(
      resolveWindowControlsBackground({
        isElectron: true,
        isMac: true,
        isExplorerOpen: true,
        ...colors,
      }),
    ).toBeNull();
    // Browser web and native have no native controls to paint.
    expect(
      resolveWindowControlsBackground({
        isElectron: false,
        isMac: false,
        isExplorerOpen: true,
        ...colors,
      }),
    ).toBeNull();
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
});
