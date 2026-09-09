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
