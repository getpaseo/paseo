import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { DEFAULT_APP_SETTINGS } from "@/hooks/use-settings";
import { usePanelStore } from "@/stores/panel-store";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  autoOpenWorkspacePullRequest,
  openComposerChanges,
  openWorkspaceChanges,
  openWorkspacePullRequest,
} from "@/workspace-tabs/open-supporting-view";

const WORKSPACE_KEY = "server-1:workspace-1";
const CHECKOUT = { serverId: "server-1", cwd: "/tmp/repo", isGit: true };

beforeEach(() => {
  usePanelStore.setState({
    mobilePanel: { target: "agent", revision: 0 },
    explorerTab: "files",
    explorerTabByCheckout: {},
  });
  useWorkspaceLayoutStore.setState({
    pullRequestTabAutoOpenedByWorkspace: {},
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
});

describe("openWorkspaceChanges", () => {
  it("opens Changes in the compact Explorer", () => {
    openWorkspaceChanges({
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
      preferences: DEFAULT_APP_SETTINGS.openInSidePane,
    });

    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    expect(usePanelStore.getState().explorerTab).toBe("changes");
  });
});

describe("openComposerChanges", () => {
  const input = {
    isCompact: false,
    supportsPaneSplits: true,
    workspaceKey: WORKSPACE_KEY,
    checkout: CHECKOUT,
    preferences: DEFAULT_APP_SETTINGS.openInSidePane,
  };

  it("opens the desktop Explorer on Changes when it is closed", () => {
    openComposerChanges(input);

    const state = useWorkspaceLayoutStore.getState();
    const explorerPaneId = state.explorerSidebarPaneIdByWorkspace[WORKSPACE_KEY];
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const explorerPane =
      layout && explorerPaneId ? findPaneById(layout.root, explorerPaneId) : null;
    const explorerTabKinds = layout
      ? collectAllTabs(layout.root)
          .filter((tab) => explorerPane?.tabIds.includes(tab.tabId))
          .map((tab) => tab.target.kind)
      : [];

    expect(explorerPane?.hidden).not.toBe(true);
    expect(explorerTabKinds).toContain("changes_tree");
    expect(layout && collectAllTabs(layout.root).map((tab) => tab.target.kind)).not.toContain(
      "working_diff",
    );
  });

  it("opens the diff through Changes link routing when the desktop Explorer is open", () => {
    openComposerChanges(input);
    openComposerChanges({
      ...input,
      preferences: { ...input.preferences, diffs: true },
    });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const sidePaneId = state.sidePaneIdByWorkspace[WORKSPACE_KEY];
    const sidePane = layout && sidePaneId ? findPaneById(layout.root, sidePaneId) : null;
    const sideTabKinds = layout
      ? collectAllTabs(layout.root)
          .filter((tab) => sidePane?.tabIds.includes(tab.tabId))
          .map((tab) => tab.target.kind)
      : [];

    expect(sideTabKinds).toContain("working_diff");
  });

  it("keeps opening the compact Explorer on Changes", () => {
    openComposerChanges({ ...input, isCompact: true });
    openComposerChanges({ ...input, isCompact: true });

    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    expect(usePanelStore.getState().explorerTab).toBe("changes");
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBeUndefined();
  });
});

describe("openWorkspacePullRequest", () => {
  const input = {
    isCompact: false,
    supportsPaneSplits: true,
    workspaceKey: WORKSPACE_KEY,
    checkout: CHECKOUT,
  };

  it.each(["main", "side", "explorer"] as const)(
    "opens the compact PR view in Explorer when the desktop preference is %s",
    (destination) => {
      openWorkspacePullRequest({ ...input, isCompact: true, destination });

      expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
      expect(usePanelStore.getState().explorerTab).toBe("pr");
      expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBeUndefined();
    },
  );

  it("opens PRs in Explorer by default", () => {
    openWorkspacePullRequest({
      ...input,
      destination: DEFAULT_APP_SETTINGS.pullRequestOpenLocation,
    });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const explorerPaneId = state.explorerSidebarPaneIdByWorkspace[WORKSPACE_KEY];
    const explorerPane =
      layout && explorerPaneId ? findPaneById(layout.root, explorerPaneId) : null;
    const pullRequestTab = layout
      ? collectAllTabs(layout.root).find((tab) => tab.target.kind === "pull_request")
      : null;

    expect(explorerPane?.tabIds).toContain(pullRequestTab?.tabId);
    expect(explorerPane?.hidden).not.toBe(true);
  });

  it("opens PRs in the main panel when configured", () => {
    openWorkspacePullRequest({ ...input, destination: "main" });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const mainPane = layout ? findPaneById(layout.root, layout.focusedPaneId) : null;
    const pullRequestTab = layout
      ? collectAllTabs(layout.root).find((tab) => tab.target.kind === "pull_request")
      : null;

    expect(mainPane?.tabIds).toContain(pullRequestTab?.tabId);
    expect(state.sidePaneIdByWorkspace[WORKSPACE_KEY]).toBeUndefined();
  });

  it("opens PRs in the side panel when configured", () => {
    openWorkspacePullRequest({ ...input, destination: "side" });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const sidePaneId = state.sidePaneIdByWorkspace[WORKSPACE_KEY];
    const sidePane = layout && sidePaneId ? findPaneById(layout.root, sidePaneId) : null;
    const pullRequestTab = layout
      ? collectAllTabs(layout.root).find((tab) => tab.target.kind === "pull_request")
      : null;

    expect(sidePane?.tabIds).toContain(pullRequestTab?.tabId);
  });
});

describe("autoOpenWorkspacePullRequest", () => {
  it("silently adds the PR after Changes once, and never restores it after closing", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "terminal", terminalId: "terminal-1" },
      intent: "background",
      placement: { mode: "prefer", paneId: "explorer" },
    });
    const before = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const input = { workspaceKey: WORKSPACE_KEY, destination: "explorer" as const };
    autoOpenWorkspacePullRequest(input);
    const after = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const explorer = findPaneById(after.root, "explorer")!;
    expect(explorer.tabIds).toEqual([
      "files",
      "changes_tree",
      "pull_request",
      "terminal_terminal-1",
    ]);
    expect(explorer.hidden).toBe(true);
    expect(explorer.focusedTabId).toBe(findPaneById(before.root, "explorer")!.focusedTabId);
    expect(after.focusedPaneId).toBe(before.focusedPaneId);
    store.closeTab(WORKSPACE_KEY, "pull_request");
    autoOpenWorkspacePullRequest(input);
    expect(
      collectAllTabs(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY].root).map(
        (tab) => tab.target.kind,
      ),
    ).not.toContain("pull_request");
  });
});

describe("automatic PR placement", () => {
  it.each(["main", "side"] as const)(
    "silently appends to the configured %s pane",
    (destination) => {
      const store = useWorkspaceLayoutStore.getState();
      store.openTab({
        workspaceKey: WORKSPACE_KEY,
        target: { kind: "agent", agentId: "agent-1" },
        intent: "reveal",
      });
      const paneId = destination === "main" ? "main" : store.ensureSidePane(WORKSPACE_KEY)!;
      store.openTab({
        workspaceKey: WORKSPACE_KEY,
        target: { kind: "terminal", terminalId: "terminal-1" },
        intent: "background",
        placement: { mode: "prefer", paneId },
      });
      const before = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
      autoOpenWorkspacePullRequest({ workspaceKey: WORKSPACE_KEY, destination });
      const after = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
      expect(findPaneById(after.root, paneId)!.tabIds).toEqual([
        ...findPaneById(before.root, paneId)!.tabIds,
        "pull_request",
      ]);
      expect(findPaneById(after.root, paneId)!.focusedTabId).toBe(
        findPaneById(before.root, paneId)!.focusedTabId,
      );
      expect(after.focusedPaneId).toBe(before.focusedPaneId);
      expect(findPaneById(after.root, "explorer")!.hidden).toBe(true);
    },
  );

  it("creates a side pane without stealing workspace focus", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    autoOpenWorkspacePullRequest({ workspaceKey: WORKSPACE_KEY, destination: "side" });
    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    expect(findPaneById(layout.root, state.sidePaneIdByWorkspace[WORKSPACE_KEY])!.tabIds).toEqual([
      "pull_request",
    ]);
    expect(layout.focusedPaneId).toBe("main");
  });

  it.each(["main", "side", "explorer"] as const)(
    "leaves a manually moved PR in main when detection prefers %s",
    (destination) => {
      const store = useWorkspaceLayoutStore.getState();
      store.openTab({
        workspaceKey: WORKSPACE_KEY,
        target: { kind: "pull_request" },
        intent: "background",
        placement: { mode: "prefer", paneId: "explorer" },
      });
      store.moveTabToPane(WORKSPACE_KEY, "pull_request", "main");
      const before = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
      autoOpenWorkspacePullRequest({ workspaceKey: WORKSPACE_KEY, destination });
      expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toEqual(before);
      expect(
        useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY],
      ).toBeUndefined();
      store.closeTab(WORKSPACE_KEY, "pull_request");
      autoOpenWorkspacePullRequest({ workspaceKey: WORKSPACE_KEY, destination });
      expect(
        collectAllTabs(
          useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY].root,
        ).map((tab) => tab.target.kind),
      ).not.toContain("pull_request");
      expect(
        useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY],
      ).toBeUndefined();
    },
  );

  it("preserves reordering before and after detection", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "pull_request" },
      intent: "background",
      placement: { mode: "prefer", paneId: "explorer" },
    });
    store.reorderTabsInPane(WORKSPACE_KEY, "explorer", ["pull_request", "files", "changes_tree"]);
    const before = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    autoOpenWorkspacePullRequest({ workspaceKey: WORKSPACE_KEY, destination: "explorer" });
    autoOpenWorkspacePullRequest({ workspaceKey: WORKSPACE_KEY, destination: "side" });
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toEqual(before);
  });

  it("appends in Explorer when Changes was closed", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.closeTab(WORKSPACE_KEY, "changes_tree");
    autoOpenWorkspacePullRequest({ workspaceKey: WORKSPACE_KEY, destination: "explorer" });
    expect(
      findPaneById(
        useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY].root,
        "explorer",
      )!.tabIds,
    ).toEqual(["files", "pull_request"]);
  });
});
