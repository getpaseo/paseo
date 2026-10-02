import { beforeEach, describe, expect, it } from "vitest";
import { useBrowserStore } from "@/desktop/browser/store";
import { createBrowserRecord, createRemoteBrowserRecord } from "@/desktop/browser/store/state";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  beginRemoteBrowserTabSync,
  syncRemoteBrowserTabs,
  whileCreatingRemoteTab,
} from "./remote-tab-sync";
import { duplicateRemoteBrowserRecordIds, getBrowserPaneKind } from "./remote-tab-records";

describe("duplicateRemoteBrowserRecordIds", () => {
  it("keeps host tabs on the host in Electron, including before a new tab is attached", () => {
    expect(
      getBrowserPaneKind({ isElectron: true, supportsHostBrowser: true, remoteBrowserId: null }),
    ).toBe("host");
    expect(
      getBrowserPaneKind({
        isElectron: true,
        supportsHostBrowser: true,
        remoteBrowserId: "host-tab",
      }),
    ).toBe("host");
    expect(
      getBrowserPaneKind({
        isElectron: true,
        supportsHostBrowser: false,
        remoteBrowserId: "host-tab",
      }),
    ).toBe("host");
    expect(
      getBrowserPaneKind({ isElectron: true, supportsHostBrowser: false, remoteBrowserId: null }),
    ).toBe("desktop");
  });
  it("drops the record adopted from a listing when the requesting record owns the same tab", () => {
    expect(
      duplicateRemoteBrowserRecordIds([
        { browserId: "local-1", remoteBrowserId: "remote-1" },
        { browserId: "remote-1", remoteBrowserId: "remote-1" },
        { browserId: "remote-2", remoteBrowserId: "remote-2" },
        { browserId: "local-3", remoteBrowserId: null },
      ]),
    ).toEqual(["remote-1"]);
  });

  it("keeps one record when two requesting records point at the same tab", () => {
    expect(
      duplicateRemoteBrowserRecordIds([
        { browserId: "local-1", remoteBrowserId: "remote-1" },
        { browserId: "local-2", remoteBrowserId: "remote-1" },
      ]),
    ).toEqual(["local-2"]);
  });
});

describe("daemon browser tab reconciliation", () => {
  const workspaceKey = "server:workspace";
  const workspaceId = "workspace";
  const listed = (browserId: string, id = workspaceId) => ({
    browserId,
    workspaceId: id,
    url: "https://example.com",
    title: "Example",
  });
  const openMirror = (browserId: string, key = workspaceKey) => {
    useBrowserStore.getState().upsertRemoteBrowser({
      browserId,
      url: "https://example.com",
    });
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: key,
      target: { kind: "browser", browserId },
      intent: "background",
    });
  };
  const openIds = () =>
    collectAllTabs(useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root)
      .filter((tab) => tab.target.kind === "browser")
      .map((tab) => (tab.target.kind === "browser" ? tab.target.browserId : ""));

  beforeEach(() => {
    useBrowserStore.setState({ browsersById: {} });
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
  });

  it("removes closed daemon mirrors from the layout and store while preserving other tabs", () => {
    openMirror("closed");
    openMirror("live");
    openMirror("other", "server:other-workspace");
    const local = createBrowserRecord({ browserId: "local", initialUrl: null, now: 1 });
    const requested = {
      ...createRemoteBrowserRecord({ browserId: "requested", initialUrl: null, now: 1 }),
      remoteBrowserId: "remote-requested",
    };
    useBrowserStore.setState((state) => ({
      browsersById: { ...state.browsersById, local, requested },
    }));
    for (const browserId of ["local", "requested"]) {
      useWorkspaceLayoutStore.getState().openTab({
        workspaceKey,
        target: { kind: "browser", browserId },
        intent: "background",
      });
    }
    syncRemoteBrowserTabs({
      tabs: [listed("live"), listed("other", "other-workspace")],
      workspaceId,
      workspaceKey,
      request: beginRemoteBrowserTabSync(workspaceKey),
    });
    expect(openIds()).toEqual(["live", "local", "requested"]);
    expect(Object.keys(useBrowserStore.getState().browsersById).sort()).toEqual([
      "live",
      "local",
      "other",
      "requested",
    ]);
  });

  it("ignores an older listing after a newer listing removed a tab", () => {
    openMirror("closed");
    const older = beginRemoteBrowserTabSync(workspaceKey);
    const newer = beginRemoteBrowserTabSync(workspaceKey);
    syncRemoteBrowserTabs({ tabs: [], workspaceId, workspaceKey, request: newer });
    syncRemoteBrowserTabs({ tabs: [listed("closed")], workspaceId, workspaceKey, request: older });
    expect(openIds()).toEqual([]);
    expect(useBrowserStore.getState().browsersById.closed).toBeUndefined();
  });

  it("keeps a mirror opened after the listing request started", () => {
    const request = beginRemoteBrowserTabSync(workspaceKey);
    openMirror("new");
    syncRemoteBrowserTabs({ tabs: [], workspaceId, workspaceKey, request });
    expect(openIds()).toEqual(["new"]);
  });

  it("applies completed listings even when a later request is still pending", () => {
    openMirror("closed");
    const request = beginRemoteBrowserTabSync(workspaceKey);
    beginRemoteBrowserTabSync(workspaceKey);
    syncRemoteBrowserTabs({ tabs: [], workspaceId, workspaceKey, request });
    expect(openIds()).toEqual([]);
  });

  it("preserves tabs during creation and reconciles on the next completed refresh", async () => {
    openMirror("creating");
    await whileCreatingRemoteTab(async () => {
      syncRemoteBrowserTabs({
        tabs: [],
        workspaceId,
        workspaceKey,
        request: beginRemoteBrowserTabSync(workspaceKey),
      });
      expect(openIds()).toEqual(["creating"]);
    });
    syncRemoteBrowserTabs({
      tabs: [],
      workspaceId,
      workspaceKey,
      request: beginRemoteBrowserTabSync(workspaceKey),
    });
    expect(openIds()).toEqual([]);
  });
});
