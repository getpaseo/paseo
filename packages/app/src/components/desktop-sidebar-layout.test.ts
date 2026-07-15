import { describe, expect, it } from "vitest";
import {
  canDesktopAppSidebarShare,
  resolveDesktopAppContentMinimum,
  resolveDesktopExplorerWidth,
  resolveDesktopSidebarWidth,
} from "@/components/desktop-sidebar-layout";

describe("desktop sidebar layout", () => {
  it("clamps a persisted wide sidebar to preserve the center pane", () => {
    const atHalfScreen = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 751 });
    expect(atHalfScreen).toBe(351);
    expect(751 - atHalfScreen).toBe(400);

    const atBreakpoint = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 720 });
    expect(atBreakpoint).toBe(320);
    expect(720 - atBreakpoint).toBe(400);

    expect(resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 1440 })).toBe(600);
  });

  it("keeps a temporarily narrow explorer render-only", () => {
    expect(resolveDesktopExplorerWidth({ requestedWidth: 400, viewportWidth: 751 })).toBe(351);
    expect(resolveDesktopExplorerWidth({ requestedWidth: 400, viewportWidth: 1440 })).toBe(400);
  });

  it("yields app navigation when settings or Explorer need the shell width", () => {
    const settingsMinimum = resolveDesktopAppContentMinimum({
      isSettingsRoute: true,
      isWorkspaceExplorerOpen: false,
      requestedExplorerWidth: 400,
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

    const explorerMinimum = resolveDesktopAppContentMinimum({
      isSettingsRoute: false,
      isWorkspaceExplorerOpen: true,
      requestedExplorerWidth: 400,
      viewportWidth: 751,
    });
    expect(explorerMinimum).toBe(751);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: explorerMinimum,
        requestedSidebarWidth: 320,
        viewportWidth: 751,
      }),
    ).toBe(false);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: resolveDesktopAppContentMinimum({
          isSettingsRoute: false,
          isWorkspaceExplorerOpen: true,
          requestedExplorerWidth: 400,
          viewportWidth: 1120,
        }),
        requestedSidebarWidth: 320,
        viewportWidth: 1120,
      }),
    ).toBe(true);
  });
});
