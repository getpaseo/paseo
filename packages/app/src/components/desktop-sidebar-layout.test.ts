import { describe, expect, it } from "vitest";
import {
  canDesktopAppSidebarShare,
  resolveDesktopAppChromeLayout,
  resolveDesktopAppContentMinimum,
  resolveDesktopSidebarVisibility,
  resolveDesktopSidebarWidth,
} from "@/components/desktop-sidebar-layout";

describe("desktop sidebar layout", () => {
  it("keeps a retained sidebar hidden while app chrome is suppressed", () => {
    expect(
      resolveDesktopSidebarVisibility({
        chromeEnabled: false,
        isCompactLayout: false,
        isMounted: true,
        isOpen: true,
        canShare: true,
      }),
    ).toBe(false);
  });

  it("keeps the sidebar toggle window-owned beside left window controls", () => {
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: true,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "top-left",
      contentCorners: "top-right",
      sidebarToggleOwner: "window",
    });
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: true,
        hasTopLeftWindowControls: false,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "none",
      contentCorners: "both",
      sidebarToggleOwner: "content",
    });
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: false,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "none",
      contentCorners: "both",
      sidebarToggleOwner: "window",
    });
  });

  it("hides the window-owned sidebar toggle when app chrome is suppressed", () => {
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: false,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: false,
      }).sidebarToggleOwner,
    ).toBe("none");
  });

  it("clamps a persisted wide sidebar to preserve the center pane", () => {
    const atHalfScreen = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 751 });
    expect(atHalfScreen).toBe(351);
    expect(751 - atHalfScreen).toBe(400);

    const atBreakpoint = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 720 });
    expect(atBreakpoint).toBe(320);
    expect(720 - atBreakpoint).toBe(400);

    expect(resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 1440 })).toBe(600);
  });

  it.each([
    { viewportWidth: 600, sidebarWidth: 200 },
    { viewportWidth: 698, sidebarWidth: 298 },
  ])(
    "preserves the center pane on a $viewportWidth dp tablet",
    ({ viewportWidth, sidebarWidth }) => {
      const visibleWidth = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth });
      expect(visibleWidth).toBe(sidebarWidth);
      expect(viewportWidth - visibleWidth).toBe(400);
    },
  );

  it("yields app navigation when settings needs the shell width", () => {
    const settingsMinimum = resolveDesktopAppContentMinimum({
      isSettingsRoute: true,
      requestedSidebarWidth: 320,
      viewportWidth: 751,
    });
    expect(settingsMinimum).toBe(720);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: settingsMinimum,
        requestedSidebarWidth: 320,
        viewportWidth: 751,
      }),
    ).toBe(false);
  });

  it.each([
    { viewportWidth: 698, requestedSidebarWidth: 240, settingsMinimum: 640, canShare: false },
    { viewportWidth: 879, requestedSidebarWidth: 240, settingsMinimum: 640, canShare: false },
    { viewportWidth: 880, requestedSidebarWidth: 240, settingsMinimum: 640, canShare: true },
    { viewportWidth: 1500, requestedSidebarWidth: 600, settingsMinimum: 1000, canShare: false },
    { viewportWidth: 1600, requestedSidebarWidth: 600, settingsMinimum: 1000, canShare: true },
  ])(
    "reserves the shared sidebar width and settings detail at $viewportWidth px",
    ({ viewportWidth, requestedSidebarWidth, settingsMinimum, canShare }) => {
      const contentMinimumWidth = resolveDesktopAppContentMinimum({
        isSettingsRoute: true,
        requestedSidebarWidth,
        viewportWidth,
      });

      expect(contentMinimumWidth).toBe(settingsMinimum);
      expect(
        canDesktopAppSidebarShare({ contentMinimumWidth, requestedSidebarWidth, viewportWidth }),
      ).toBe(canShare);
    },
  );

  it("imposes no content minimum outside settings", () => {
    const contentMinimumWidth = resolveDesktopAppContentMinimum({
      isSettingsRoute: false,
      requestedSidebarWidth: 320,
      viewportWidth: 751,
    });
    expect(contentMinimumWidth).toBe(0);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth,
        requestedSidebarWidth: 320,
        viewportWidth: 751,
      }),
    ).toBe(true);
  });
});
