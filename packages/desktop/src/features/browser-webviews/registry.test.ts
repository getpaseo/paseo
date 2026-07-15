import { describe, expect, it } from "vitest";
import { PaseoBrowserWebviewRegistry } from "./registry.js";

describe("PaseoBrowserWebviewRegistry", () => {
  it("keeps one authoritative webContents target per browserId", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({ webContentsId: 1, browserId: "browser-a" });
    registry.registerWorkspace({ browserId: "browser-a", workspaceId: "workspace-a" });
    registry.setWorkspaceActiveBrowser({ workspaceId: "workspace-a", browserId: "browser-a" });
    registry.registerWebContents({ webContentsId: 2, browserId: "browser-a" });

    expect(registry.getBrowserIdForWebContents(1)).toBeNull();
    expect(registry.getBrowserIdForWebContents(2)).toBe("browser-a");
    expect(registry.getWebContentsIdForBrowser("browser-a")).toBe(2);
    expect(registry.getWorkspaceId("browser-a")).toBe("workspace-a");
    expect(registry.getWorkspaceActiveBrowserId("workspace-a")).toBe("browser-a");
  });

  it("ignores stale destroy events after a duplicate browserId moved", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({ webContentsId: 1, browserId: "browser-a" });
    registry.registerWebContents({ webContentsId: 2, browserId: "browser-a" });
    registry.unregisterWebContents(1);

    expect(registry.getWebContentsIdForBrowser("browser-a")).toBe(2);
  });

  it("keeps one browser identity per webContents target", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({ webContentsId: 1, browserId: "browser-a" });
    registry.registerWorkspace({ browserId: "browser-a", workspaceId: "workspace-a" });
    registry.setWorkspaceActiveBrowser({ workspaceId: "workspace-a", browserId: "browser-a" });
    registry.registerWebContents({ webContentsId: 1, browserId: "browser-b" });

    expect(registry.getWebContentsIdForBrowser("browser-a")).toBeNull();
    expect(registry.getWorkspaceId("browser-a")).toBeNull();
    expect(registry.getWorkspaceActiveBrowserId("workspace-a")).toBeNull();
    expect(registry.getBrowserIdForWebContents(1)).toBe("browser-b");
  });
});
