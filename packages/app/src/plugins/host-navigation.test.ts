import { indexedDB as fakeIndexedDb } from "fake-indexeddb";

import { describe, expect, it } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore, findPaneContainingTab } from "@/stores/workspace-layout-store";
import { useBrowserStore } from "@/desktop/browser/store";
import { openWorkspaceBrowser } from "@/workspace-tabs/browser";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { createPluginHostNavigation } from "./host-navigation-model";

globalThis.indexedDB = fakeIndexedDb;

describe("plugin host navigation", () => {
  function setup(electron = true) {
    const destinations: unknown[] = [];
    const browsers: string[] = [];
    const workspaces = new Set(["selected:one", "remote:two", "remote:one"]);
    const opened: Array<{ tabId: string; browserId: string }> = [];
    useSessionStore.setState({ sessions: {} });
    useBrowserStore.setState({ browsersById: {} });
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {},
      browserPaneIdByWorkspace: {},
      sidePaneIdByWorkspace: {},
      explorerSidebarPaneIdByWorkspace: {},
      focusRestorationByWorkspace: {},
    });
    for (const serverId of ["selected", "remote"]) {
      useSessionStore.getState().initializeSession(serverId, null);
      useSessionStore.getState().setWorkspaces(
        serverId,
        new Map(
          ["one", "two"].map((id) => [
            id,
            {
              id,
              projectId: "project-1",
              projectDisplayName: "Project",
              projectRootPath: "/repo",
              workspaceDirectory: "/repo",
              projectKind: "git",
              workspaceKind: "directory",
              name: "Workspace",
              status: "running",
              statusEnteredAt: null,
              archivingAt: null,
              diffStat: null,
              scripts: [],
            },
          ]),
        ),
      );
    }
    const navigation = createPluginHostNavigation("selected", {
      browserAvailable: electron,
      resolveWorkspace: ({ serverId, workspaceId }) =>
        workspaces.has(`${serverId}:${workspaceId}`) ? workspaceId : null,
      openAgent: (input) => destinations.push(input),
      openWorkspace: (input) => destinations.push(input),
      openBrowser: (input) => {
        const result = openWorkspaceBrowser(input);
        if (result.ok) {
          browsers.push(input.url!);
          opened.push(result);
        }
        return result;
      },
    });
    return { navigation, destinations, browsers, workspaces, opened };
  }

  it("creates and focuses a local browser in the selected or explicit host workspace", () => {
    const { navigation, destinations, browsers, opened } = setup();
    navigation.openBrowser!({ url: "https://example.com/one", workspaceId: "one" });
    navigation.openBrowser!({
      url: "https://example.com/two",
      workspaceId: "two",
      serverId: "remote",
    });
    expect(browsers).toEqual(["https://example.com/one", "https://example.com/two"]);
    expect(destinations).toEqual([
      {
        serverId: "selected",
        workspaceId: "one",
        target: { kind: "browser", browserId: opened[0].browserId },
      },
      {
        serverId: "remote",
        workspaceId: "two",
        target: { kind: "browser", browserId: opened[1].browserId },
      },
    ]);
  });

  it("refuses unknown or removed workspaces before creating browser records", () => {
    const { navigation, destinations, browsers, workspaces } = setup();
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "missing" }),
    ).toThrow("Workspace is unavailable");
    expect(() =>
      navigation.openBrowser!({
        url: "https://example.com",
        workspaceId: "one",
        serverId: "unknown",
      }),
    ).toThrow("Workspace is unavailable");
    workspaces.delete("selected:one");
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "one" }),
    ).toThrow("Workspace is unavailable");
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it("exposes no browser capability outside Electron and creates no tabs", () => {
    const { navigation, destinations, browsers } = setup(false);
    expect(navigation.openBrowser).toBeUndefined();
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it.each(["javascript:alert(1)", "file:///tmp/file", "/relative", "invalid"])(
    "rejects %s before creating a browser",
    (url) => {
      const { navigation, browsers, destinations } = setup();
      expect(() => navigation.openBrowser!({ url, workspaceId: "one" })).toThrow("HTTP(S)");
      expect(browsers).toEqual([]);
      expect(destinations).toEqual([]);
    },
  );

  it("rejects an empty workspace before creating a browser", () => {
    const { navigation, browsers } = setup();
    expect(() => navigation.openBrowser!({ url: "https://example.com", workspaceId: "" })).toThrow(
      "workspaceId",
    );
    expect(browsers).toEqual([]);
  });
  it("opens identical workspace IDs on separate hosts, including a destination with no prior layout", () => {
    const { navigation, destinations, opened } = setup();
    const localKey = buildWorkspaceTabPersistenceKey({ serverId: "selected", workspaceId: "one" })!;
    const remoteKey = buildWorkspaceTabPersistenceKey({ serverId: "remote", workspaceId: "one" })!;
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[remoteKey]).toBeUndefined();
    navigation.openBrowser!({ workspaceId: "one", url: "https://example.com" });
    navigation.openBrowser!({ workspaceId: "one", serverId: "remote", url: "https://example.com" });
    expect(opened[0].browserId).not.toBe(opened[1].browserId);
    expect(
      useWorkspaceLayoutStore
        .getState()
        .getWorkspaceTabs(localKey)
        .filter((tab) => tab.target.kind === "browser"),
    ).toEqual([expect.objectContaining({ tabId: opened[0].tabId })]);
    expect(
      useWorkspaceLayoutStore
        .getState()
        .getWorkspaceTabs(remoteKey)
        .filter((tab) => tab.target.kind === "browser"),
    ).toEqual([expect.objectContaining({ tabId: opened[1].tabId })]);
    const remoteLayout = useWorkspaceLayoutStore.getState().layoutByWorkspace[remoteKey];
    expect(remoteLayout.focusedPaneId).toBe(
      findPaneContainingTab(remoteLayout.root, opened[1].tabId)?.id,
    );
    expect(destinations.at(-1)).toEqual({
      serverId: "remote",
      workspaceId: "one",
      target: { kind: "browser", browserId: opened[1].browserId },
    });
  });

  it("reports shared placement failure without navigating or creating a record", () => {
    const destinations: unknown[] = [];
    const navigation = createPluginHostNavigation("selected", {
      browserAvailable: true,
      resolveWorkspace: () => "one",
      openAgent: () => {},
      openWorkspace: (input) => destinations.push(input),
      openBrowser: () => ({ ok: false, code: "placement_unavailable" }),
    });
    expect(() =>
      navigation.openBrowser!({ workspaceId: "one", url: "https://example.com" }),
    ).toThrow("placement_unavailable");
    expect(destinations).toEqual([]);
  });
});
