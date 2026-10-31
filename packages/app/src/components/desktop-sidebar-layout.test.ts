import { describe, expect, it } from "vitest";
import {
  resolveExplorerSidebarDockSizes,
  resolveExplorerSidebarWidth,
} from "@/components/explorer-sidebar-layout";
import {
  canDesktopAppSidebarShare,
  resolveDesktopAppChromeLayout,
  resolveDesktopAppContentMinimum,
  resolveDesktopSidebarVisibility,
  resolveDesktopSidebarWidth,
} from "@/components/desktop-sidebar-layout";

describe("desktop sidebar layout", () => {
  it("yields navigation at 960 dp without shrinking the Explorer", () => {
    const contentMinimumWidth = resolveDesktopAppContentMinimum({
      isSettingsRoute: false,
      isWorkspaceExplorerOpen: true,
      requestedSidebarWidth: 320,
      requestedExplorerSidebarWidth: 320,
      viewportWidth: 960,
    });
    expect(contentMinimumWidth).toBe(720);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth,
        requestedSidebarWidth: 320,
        viewportWidth: 960,
      }),
    ).toBe(false);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 320, containerWidth: 960 })).toBe(320);
  });

  it.each([
    { viewportWidth: 600, explorerWidth: 240, centerWidth: 360, canShare: false },
    { viewportWidth: 639, explorerWidth: 240, centerWidth: 399, canShare: false },
    { viewportWidth: 640, explorerWidth: 240, centerWidth: 400, canShare: false },
    { viewportWidth: 960, explorerWidth: 320, centerWidth: 640, canShare: false },
    { viewportWidth: 1000, explorerWidth: 320, centerWidth: 680, canShare: false },
    { viewportWidth: 1039, explorerWidth: 320, centerWidth: 719, canShare: false },
    { viewportWidth: 1040, explorerWidth: 320, centerWidth: 400, canShare: true },
  ])(
    "preserves Explorer before navigation at $viewportWidth dp",
    ({ viewportWidth, explorerWidth, centerWidth, canShare }) => {
      const requestedSidebarWidth = 320;
      const contentMinimumWidth = resolveDesktopAppContentMinimum({
        isSettingsRoute: false,
        isWorkspaceExplorerOpen: true,
        requestedSidebarWidth,
        viewportWidth,
      });
      expect(contentMinimumWidth).toBe(explorerWidth + 400);
      expect(
        canDesktopAppSidebarShare({
          contentMinimumWidth,
          requestedSidebarWidth,
          viewportWidth,
        }),
      ).toBe(canShare);
      const navigationWidth = canShare
        ? resolveDesktopSidebarWidth({ requestedWidth: requestedSidebarWidth, viewportWidth })
        : 0;
      const containerWidth = viewportWidth - navigationWidth;
      expect(resolveExplorerSidebarWidth({ containerWidth })).toBe(explorerWidth);
      const [mainRatio, explorerRatio] = resolveExplorerSidebarDockSizes({ containerWidth });
      expect(explorerRatio * containerWidth).toBeCloseTo(explorerWidth);
      expect(mainRatio * containerWidth).toBeCloseTo(centerWidth);
    },
  );

  it.each([
    { viewportWidth: 1040, canShare: false },
    { viewportWidth: 1079, canShare: false },
    { viewportWidth: 1080, canShare: true },
  ])(
    "restores navigation beside a saved 360 dp Explorer at $viewportWidth dp",
    ({ viewportWidth, canShare }) => {
      const input = Object.freeze({
        isSettingsRoute: false,
        isWorkspaceExplorerOpen: true,
        requestedSidebarWidth: 320,
        requestedExplorerSidebarWidth: 360,
        viewportWidth,
      });
      const contentMinimumWidth = resolveDesktopAppContentMinimum(input);
      expect(contentMinimumWidth).toBe(760);
      expect(canDesktopAppSidebarShare({ ...input, contentMinimumWidth })).toBe(canShare);
      expect(input.requestedSidebarWidth).toBe(320);
      expect(input.requestedExplorerSidebarWidth).toBe(360);
    },
  );

  it("restores a saved wide navigation after Explorer closes or the window widens", () => {
    const input: Parameters<typeof resolveDesktopAppContentMinimum>[0] = Object.freeze({
      isSettingsRoute: false,
      isWorkspaceExplorerOpen: true,
      requestedSidebarWidth: 600,
      requestedExplorerSidebarWidth: 600,
      viewportWidth: 1000,
    });
    const canShare = (overrides: Partial<typeof input>) => {
      const next = { ...input, ...overrides };
      return canDesktopAppSidebarShare({
        ...next,
        contentMinimumWidth: resolveDesktopAppContentMinimum(next),
      });
    };
    expect(canShare({})).toBe(false);
    expect(canShare({ isWorkspaceExplorerOpen: false })).toBe(true);
    expect(canShare({ viewportWidth: 1599 })).toBe(false);
    expect(canShare({ viewportWidth: 1600 })).toBe(true);
    expect(
      resolveDesktopSidebarWidth({
        requestedWidth: input.requestedSidebarWidth,
        viewportWidth: 1600,
      }),
    ).toBe(600);
    expect(input.requestedExplorerSidebarWidth).toBe(600);
  });

  it("restores navigation at the boundary after a fractional resize round trip", () => {
    const contentMinimumWidth = resolveDesktopAppContentMinimum({
      isSettingsRoute: false,
      isWorkspaceExplorerOpen: true,
      requestedSidebarWidth: 320,
      requestedExplorerSidebarWidth: 360.0000000000001,
      viewportWidth: 1080,
    });
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth,
        requestedSidebarWidth: 320,
        viewportWidth: 1080,
      }),
    ).toBe(true);
  });

  it.each([
    { isCompactLayout: true, isMounted: true },
    { isCompactLayout: false, isMounted: false },
  ])(
    "does not reveal navigation in compact or focus mode: %o",
    ({ isCompactLayout, isMounted }) => {
      expect(
        resolveDesktopSidebarVisibility({
          chromeEnabled: true,
          isCompactLayout,
          isMounted,
          isOpen: true,
          canShare: true,
        }),
      ).toBe(false);
    },
  );

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
      isWorkspaceExplorerOpen: false,
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
        isWorkspaceExplorerOpen: false,
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
      isWorkspaceExplorerOpen: false,
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

it("reserves room for Explorer and the workspace before showing app navigation", () => {
  const contentMinimumWidth = resolveDesktopAppContentMinimum({
    isSettingsRoute: false,
    isWorkspaceExplorerOpen: true,
    requestedSidebarWidth: 320,
    viewportWidth: 1040,
  });
  expect(contentMinimumWidth).toBe(720);
  expect(
    canDesktopAppSidebarShare({
      contentMinimumWidth,
      requestedSidebarWidth: 320,
      viewportWidth: 744,
    }),
  ).toBe(false);
  expect(
    canDesktopAppSidebarShare({
      contentMinimumWidth,
      requestedSidebarWidth: 320,
      viewportWidth: 1040,
    }),
  ).toBe(true);
});
