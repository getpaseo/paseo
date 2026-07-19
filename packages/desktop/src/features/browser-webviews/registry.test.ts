import { describe, expect, it } from "vitest";
import { PaseoBrowserWebviewRegistry } from "./registry.js";

describe("PaseoBrowserWebviewRegistry", () => {
  it("keeps one authoritative webContents target per host and browser", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({
      webContentsId: 1,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    registry.registerWorkspace({ browserId: "browser-a", workspaceId: "workspace-a" });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-a",
    });
    registry.registerWebContents({
      webContentsId: 2,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });

    expect(registry.getBrowserIdForWebContents(1)).toBeNull();
    expect(registry.getBrowserIdForWebContents(2)).toBe("browser-a");
    expect(registry.getRegistrationForWebContents(2)).toEqual({
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    expect(registry.getWebContentsIdForBrowserInHostWindow(101, "browser-a")).toBe(2);
    expect(registry.getWorkspaceId("browser-a")).toBe("workspace-a");
    expect(registry.getActiveBrowserIdForHostWindow(101)).toBe("browser-a");
  });

  it("keeps the active browser when the same guest registers again", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({
      webContentsId: 1,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-a",
    });

    registry.registerWebContents({
      webContentsId: 1,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });

    expect(registry.getActiveBrowserIdForWorkspaceInHostWindow(101, "workspace-a")).toBe(
      "browser-a",
    );
    expect(registry.getWebContentsIdForBrowserInHostWindow(101, "browser-a")).toBe(1);
  });

  it("ignores stale destroy events after a duplicate browserId moved", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({
      webContentsId: 1,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    registry.registerWebContents({
      webContentsId: 2,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    registry.unregisterWebContents(1);

    expect(registry.getWebContentsIdForBrowserInHostWindow(101, "browser-a")).toBe(2);
  });

  it("returns the active browser only from the requested host window", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-first-window",
      hostWebContentsId: 101,
    });
    registry.registerWebContents({
      webContentsId: 22,
      browserId: "browser-second-window",
      hostWebContentsId: 202,
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-first-window",
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 202,
      workspaceId: "workspace-a",
      browserId: "browser-second-window",
    });

    expect(registry.getActiveBrowserIdForHostWindow(101)).toBe("browser-first-window");
    expect(registry.getActiveBrowserIdForHostWindow(202)).toBe("browser-second-window");
    expect(registry.getActiveBrowserIdForWorkspaceInHostWindow(101, "workspace-a")).toBe(
      "browser-first-window",
    );
    expect(registry.getActiveBrowserIdForWorkspaceInHostWindow(202, "workspace-a")).toBe(
      "browser-second-window",
    );
  });

  it("keeps active updates and clears inside their owning host window", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-first-window",
      hostWebContentsId: 101,
    });
    registry.registerWebContents({
      webContentsId: 22,
      browserId: "browser-second-window",
      hostWebContentsId: 202,
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-first-window",
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 202,
      workspaceId: "workspace-a",
      browserId: "browser-second-window",
    });

    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-second-window",
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: null,
    });

    expect(registry.getActiveBrowserIdForHostWindow(101)).toBeNull();
    expect(registry.getActiveBrowserIdForHostWindow(202)).toBe("browser-second-window");
  });

  it("keeps same-browser active references in separate host windows", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-a",
    });
    registry.registerWebContents({
      webContentsId: 22,
      browserId: "browser-a",
      hostWebContentsId: 202,
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 202,
      workspaceId: "workspace-a",
      browserId: "browser-a",
    });

    expect(registry.getActiveBrowserIdForHostWindow(101)).toBe("browser-a");
    expect(registry.getActiveBrowserIdForHostWindow(202)).toBe("browser-a");
    expect(registry.getWebContentsIdForBrowserInHostWindow(101, "browser-a")).toBe(11);
    expect(registry.getWebContentsIdForBrowserInHostWindow(202, "browser-a")).toBe(22);
  });

  it("removes only the closing host's same-browser guest", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    registry.registerWebContents({
      webContentsId: 22,
      browserId: "browser-a",
      hostWebContentsId: 202,
    });

    registry.unregisterHostWebContents(101);

    expect(registry.getRegistrationForWebContents(11)).toBeNull();
    expect(registry.getWebContentsIdForBrowserInHostWindow(101, "browser-a")).toBeNull();
    expect(registry.getRegistrationForWebContents(22)).toEqual({
      browserId: "browser-a",
      hostWebContentsId: 202,
    });
    expect(registry.getWebContentsIdForBrowserInHostWindow(202, "browser-a")).toBe(22);
  });

  it("unregisters a browser only from the requesting host", () => {
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    registry.registerWebContents({
      webContentsId: 22,
      browserId: "browser-a",
      hostWebContentsId: 202,
    });
    registry.registerWorkspace({ browserId: "browser-a", workspaceId: "workspace-a" });

    registry.unregisterBrowserFromHost(101, "browser-a");

    expect(registry.getWebContentsIdForBrowserInHostWindow(101, "browser-a")).toBeNull();
    expect(registry.getWebContentsIdForBrowserInHostWindow(202, "browser-a")).toBe(22);
    expect(registry.getWorkspaceId("browser-a")).toBe("workspace-a");
  });

  it("keeps another host's active browser when one guest is destroyed", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    registry.registerWebContents({
      webContentsId: 22,
      browserId: "browser-a",
      hostWebContentsId: 202,
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-a",
    });
    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 202,
      workspaceId: "workspace-a",
      browserId: "browser-a",
    });

    registry.unregisterWebContents(11);

    expect(registry.getActiveBrowserIdForHostWindow(101)).toBeNull();
    expect(registry.getActiveBrowserIdForHostWindow(202)).toBe("browser-a");
    expect(registry.getWebContentsIdForBrowserInHostWindow(202, "browser-a")).toBe(22);
  });

  it("keeps the same-window active selection made before the guest attaches", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-a",
    });
    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });

    expect(registry.getActiveBrowserIdForHostWindow(101)).toBe("browser-a");
  });

  it("keeps a pre-attach selection when another host attaches the same browser", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-a",
    });
    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-a",
      hostWebContentsId: 202,
    });

    expect(registry.getActiveBrowserIdForHostWindow(101)).toBe("browser-a");
    expect(registry.getActiveBrowserIdForHostWindow(202)).toBeNull();
  });

  it("keeps a pre-attach selection when another host tears down the same browser", () => {
    const registry = new PaseoBrowserWebviewRegistry();

    registry.setWorkspaceActiveBrowser({
      hostWebContentsId: 101,
      workspaceId: "workspace-a",
      browserId: "browser-a",
    });
    registry.registerWebContents({
      webContentsId: 22,
      browserId: "browser-a",
      hostWebContentsId: 202,
    });
    registry.unregisterWebContents(22);
    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });

    expect(registry.getActiveBrowserIdForHostWindow(101)).toBe("browser-a");
  });

  it("reports when another host still owns the same browser", () => {
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({
      webContentsId: 11,
      browserId: "browser-a",
      hostWebContentsId: 101,
    });
    registry.registerWebContents({
      webContentsId: 22,
      browserId: "browser-a",
      hostWebContentsId: 202,
    });

    expect(registry.hasBrowserInOtherHostWindow(101, "browser-a")).toBe(true);
    expect(registry.hasBrowserInOtherHostWindow(202, "browser-a")).toBe(true);
    expect(registry.hasBrowserInOtherHostWindow(101, "browser-b")).toBe(false);

    registry.unregisterWebContents(22);

    expect(registry.hasBrowserInOtherHostWindow(101, "browser-a")).toBe(false);
  });
});
