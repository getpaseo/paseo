import { describe, expect, it } from "vitest";
import {
  resolveRawWindowControlsPadding,
  resolveWindowControlsPadding,
} from "@/utils/desktop-window";

const rawPadding = {
  left: 80,
  right: 48,
  top: 28,
};

describe("resolveWindowControlsPadding", () => {
  it("keeps mac traffic-light padding available when the app window is not fullscreen", () => {
    expect(
      resolveRawWindowControlsPadding({ isElectron: true, isMac: true, isFullscreen: false }),
    ).toEqual({
      left: 78,
      right: 0,
      top: 45,
    });
  });

  it("keeps Windows and Linux window-control padding available when the app window is not fullscreen", () => {
    expect(
      resolveRawWindowControlsPadding({ isElectron: true, isMac: false, isFullscreen: false }),
    ).toEqual({
      left: 0,
      right: 140,
      top: 48,
    });
  });

  it("does not reserve window-control padding when the app window is fullscreen", () => {
    expect(
      resolveRawWindowControlsPadding({ isElectron: true, isMac: true, isFullscreen: true }),
    ).toEqual({
      left: 0,
      right: 0,
      top: 0,
    });
  });

  it("pads the main header for window controls when the app sidebar is closed", () => {
    expect(
      resolveWindowControlsPadding({
        role: "header",
        rawPadding,
        sidebarClosed: true,
        explorerOpen: false,
        focusModeEnabled: false,
      }),
    ).toEqual({
      left: 80,
      right: 48,
      top: 0,
    });
  });

  it("does not add left padding to detail headers with their own sidebar", () => {
    expect(
      resolveWindowControlsPadding({
        role: "detailHeader",
        rawPadding,
        sidebarClosed: true,
        explorerOpen: false,
        focusModeEnabled: false,
      }),
    ).toEqual({
      left: 0,
      right: 48,
      top: 0,
    });
  });

  it("pads a focus-mode tab row away from mac traffic lights even when the sidebar is logically open", () => {
    expect(
      resolveWindowControlsPadding({
        role: "tabRow",
        rawPadding,
        sidebarClosed: false,
        explorerOpen: false,
        focusModeEnabled: true,
      }),
    ).toEqual({
      left: 80,
      right: 48,
      top: 0,
    });
  });

  it("pads a focus-mode tab row away from right-side window controls even when the explorer is logically open", () => {
    expect(
      resolveWindowControlsPadding({
        role: "tabRow",
        rawPadding: { left: 0, right: 140, top: 48 },
        sidebarClosed: true,
        explorerOpen: true,
        focusModeEnabled: true,
      }),
    ).toEqual({
      left: 0,
      right: 140,
      top: 0,
    });
  });
});
