import { describe, expect, it, vi } from "vitest";

import {
  applyWindowControlsOverlayUpdate,
  createWindowControlsOverlayState,
  getMainWindowChromeOptions,
  getTitleBarOverlayOptions,
  readBadgeCount,
  readWindowControlsOverlayUpdate,
  readWindowTheme,
  resolveRuntimeTitleBarOverlayOptions,
} from "./window-manager";

describe("window-manager", () => {
  describe("readBadgeCount", () => {
    it("returns valid non-negative integers", () => {
      expect(readBadgeCount(0)).toBe(0);
      expect(readBadgeCount(3)).toBe(3);
    });

    it("falls back to zero for invalid payloads", () => {
      expect(readBadgeCount(undefined)).toBe(0);
      expect(readBadgeCount(null)).toBe(0);
      expect(readBadgeCount(Number.NaN)).toBe(0);
      expect(readBadgeCount(Number.POSITIVE_INFINITY)).toBe(0);
      expect(readBadgeCount(-1)).toBe(0);
      expect(readBadgeCount(1.5)).toBe(0);
      expect(readBadgeCount("2")).toBe(0);
      expect(readBadgeCount({ count: 2 })).toBe(0);
    });
  });

  describe("readWindowTheme", () => {
    it("accepts supported title bar themes", () => {
      expect(readWindowTheme("light")).toBe("light");
      expect(readWindowTheme("dark")).toBe("dark");
    });

    it("rejects invalid title bar themes", () => {
      expect(readWindowTheme(undefined)).toBeNull();
      expect(readWindowTheme("auto")).toBeNull();
      expect(readWindowTheme("system")).toBeNull();
    });
  });

  describe("getTitleBarOverlayOptions", () => {
    it("returns light title bar overlay colors", () => {
      expect(getTitleBarOverlayOptions("light")).toEqual({
        color: "#ffffff",
        symbolColor: "#09090b",
        height: 29,
      });
    });

    it("returns dark title bar overlay colors", () => {
      expect(getTitleBarOverlayOptions("dark")).toEqual({
        color: "#18181c",
        symbolColor: "#e4e4e7",
        height: 29,
      });
    });
  });

  describe("readWindowControlsOverlayUpdate", () => {
    it("accepts partial runtime overlay updates", () => {
      expect(
        readWindowControlsOverlayUpdate({
          height: 48,
          backgroundColor: "#18181c",
        }),
      ).toEqual({
        height: 48,
        backgroundColor: "#18181c",
      });
    });

    it("rejects empty and invalid payloads", () => {
      expect(readWindowControlsOverlayUpdate(undefined)).toBeNull();
      expect(readWindowControlsOverlayUpdate({})).toBeNull();
      expect(readWindowControlsOverlayUpdate({ height: 0 })).toBeNull();
      expect(readWindowControlsOverlayUpdate({ backgroundColor: 12 })).toBeNull();
    });
  });

  describe("resolveRuntimeTitleBarOverlayOptions", () => {
    it("applies the VS Code height minus border adjustment", () => {
      expect(
        resolveRuntimeTitleBarOverlayOptions({
          height: 48,
          backgroundColor: "#ffffff",
          foregroundColor: "#09090b",
        }),
      ).toEqual({
        color: "#ffffff",
        symbolColor: "#09090b",
        height: 47,
      });
    });
  });

  describe("applyWindowControlsOverlayUpdate", () => {
    it("merges cached colors with later runtime height updates", () => {
      const setTitleBarOverlay = vi.fn();
      let state = createWindowControlsOverlayState("dark");

      state = applyWindowControlsOverlayUpdate({
        win: { setTitleBarOverlay },
        current: state,
        update: {
          backgroundColor: "#18181c",
          foregroundColor: "#e4e4e7",
        },
      });

      state = applyWindowControlsOverlayUpdate({
        win: { setTitleBarOverlay },
        current: state,
        update: { height: 48 },
      });

      expect(state).toEqual({
        height: 48,
        backgroundColor: "#18181c",
        foregroundColor: "#e4e4e7",
      });
      expect(setTitleBarOverlay).toHaveBeenNthCalledWith(1, {
        color: "#18181c",
        symbolColor: "#e4e4e7",
        height: 28,
      });
      expect(setTitleBarOverlay).toHaveBeenNthCalledWith(2, {
        color: "#18181c",
        symbolColor: "#e4e4e7",
        height: 47,
      });
    });
  });

  describe("getMainWindowChromeOptions", () => {
    it("uses frameless hidden title bars with overlay on windows", () => {
      expect(
        getMainWindowChromeOptions({
          platform: "win32",
          theme: "dark",
        }),
      ).toEqual({
        titleBarStyle: "hidden",
        frame: false,
        autoHideMenuBar: true,
        titleBarOverlay: {
          color: "#18181c",
          symbolColor: "#e4e4e7",
          height: 29,
        },
      });
    });

    it("uses frameless hidden title bars with overlay on linux", () => {
      expect(
        getMainWindowChromeOptions({
          platform: "linux",
          theme: "light",
        }),
      ).toEqual({
        titleBarStyle: "hidden",
        frame: false,
        autoHideMenuBar: true,
        titleBarOverlay: {
          color: "#ffffff",
          symbolColor: "#09090b",
          height: 29,
        },
      });
    });

    it("keeps the mac traffic-light path separate", () => {
      expect(
        getMainWindowChromeOptions({
          platform: "darwin",
          theme: "dark",
        }),
      ).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: true,
        trafficLightPosition: { x: 16, y: 14 },
      });
    });
  });
});
