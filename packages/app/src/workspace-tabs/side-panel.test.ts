import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import { usePanelStore } from "@/stores/panel-store";
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  findPaneContainingTab,
  selectSidePanelPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  hideSidePanel,
  isSidePanelOpen,
  openSidePanelView,
  openSupportingTab,
  showSidePanel,
  toggleSidePanel,
} from "@/workspace-tabs/side-panel";

const WORKSPACE_KEY = "server-1:ws-main";
const CHECKOUT = { serverId: "server-1", cwd: "/tmp/repo", isGit: true };

function layout() {
  const value = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
  if (!value) throw new Error("workspace layout missing");
  return value;
}

function tabKinds(): string[] {
  return collectAllTabs(layout().root).map((tab) => tab.target.kind);
}

function focusedPaneTabKinds(): string[] {
  const current = layout();
  const pane = findPaneById(current.root, current.focusedPaneId);
  const tabs = collectAllTabs(current.root);
  return (pane?.tabIds ?? []).map(
    (tabId) => tabs.find((tab) => tab.tabId === tabId)?.target.kind ?? "?",
  );
}

function sidePanelPaneId(): string | null {
  return selectSidePanelPaneId(useWorkspaceLayoutStore.getState(), WORKSPACE_KEY);
}

function paneIdHolding(tabId: string): string | undefined {
  return findPaneContainingTab(layout().root, tabId)?.id;
}

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    sidePanelPaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
  usePanelStore.setState({ mobilePanel: { target: "agent", revision: 0 } });
});

describe("compact surface", () => {
  const compact = { isCompact: true, workspaceKey: WORKSPACE_KEY, checkout: CHECKOUT };

  it("opens and closes the overlay without touching the layout", () => {
    openSidePanelView({ ...compact, view: "files" });

    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    expect(usePanelStore.getState().explorerTab).toBe("files");
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBeUndefined();

    toggleSidePanel(compact);
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  });

  it("reports the overlay state, not the layout state", () => {
    expect(isSidePanelOpen({ isCompact: true, workspaceKey: WORKSPACE_KEY })).toBe(false);
    toggleSidePanel(compact);
    expect(isSidePanelOpen({ isCompact: true, workspaceKey: WORKSPACE_KEY })).toBe(true);
  });
});

describe("non-compact with splits", () => {
  const wide = {
    isCompact: false,
    supportsPaneSplits: true,
    workspaceKey: WORKSPACE_KEY,
    checkout: CHECKOUT,
  };

  it("reveals an empty pane rather than seeding a view into it", () => {
    toggleSidePanel(wide);

    expect(isSidePanelOpen(wide)).toBe(true);
    expect(tabKinds()).toEqual([]);
    expect(collectAllPanes(layout().root).length).toBeGreaterThan(1);
  });

  it("opens the view the user picked from the revealed panel", () => {
    showSidePanel(wide);
    openSidePanelView({ ...wide, view: "changes" });

    const changesTabId = collectAllTabs(layout().root).find(
      (tab) => tab.target.kind === "working_diff",
    )?.tabId;
    expect(changesTabId).toBeTruthy();
    expect(paneIdHolding(changesTabId as string)).toBe(sidePanelPaneId());
  });

  it("hides the pane on the second toggle and restores its tabs on the third", () => {
    openSidePanelView({ ...wide, view: "changes" });
    toggleSidePanel(wide);
    expect(isSidePanelOpen(wide)).toBe(false);

    toggleSidePanel(wide);
    expect(isSidePanelOpen(wide)).toBe(true);
    expect(tabKinds().filter((kind) => kind === "working_diff")).toHaveLength(1);
  });

  it("leaves the compact overlay alone", () => {
    toggleSidePanel(wide);
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  });

  it("routes a new supporting tab into the side panel", () => {
    const tabId = openSupportingTab({
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "files" },
      openInSidePanelByDefault: true,
    });

    expect(tabId).not.toBeNull();
    expect(paneIdHolding(tabId as string)).toBe(sidePanelPaneId());
    expect(isSidePanelOpen(wide)).toBe(true);
  });

  it("finds a supporting tab the user moved instead of dragging it back", () => {
    const tabId = openSupportingTab({
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "files" },
      openInSidePanelByDefault: true,
    }) as string;
    useWorkspaceLayoutStore.getState().moveTabToPane(WORKSPACE_KEY, tabId, "main");

    const reopened = openSupportingTab({
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "files" },
      openInSidePanelByDefault: true,
    });

    expect(reopened).toBe(tabId);
    expect(paneIdHolding(tabId)).toBe("main");
  });

  it("opens a new supporting tab in the focused pane when routing is off", () => {
    const tabId = openSupportingTab({
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "files" },
      openInSidePanelByDefault: false,
    });

    expect(paneIdHolding(tabId as string)).toBe(layout().focusedPaneId);
    expect(isSidePanelOpen(wide)).toBe(false);
  });

  it("adds a background supporting tab without revealing the panel", () => {
    const tabId = openSupportingTab({
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "setup", workspaceId: "ws-main" },
      openInSidePanelByDefault: true,
      background: true,
    });

    expect(paneIdHolding(tabId as string)).toBe(sidePanelPaneId());
    expect(isSidePanelOpen(wide)).toBe(false);
  });

  it("keeps the panel's tabs when it is hidden", () => {
    openSidePanelView({ ...wide, view: "files" });
    hideSidePanel(wide);

    expect(isSidePanelOpen(wide)).toBe(false);
    expect(tabKinds()).toEqual(["files"]);
  });
});

describe("non-compact without splits", () => {
  const tablet = {
    isCompact: false,
    supportsPaneSplits: false,
    workspaceKey: WORKSPACE_KEY,
    checkout: CHECKOUT,
  };

  it("opens the side panel as a tab in the focused pane, never a second pane", () => {
    toggleSidePanel(tablet);

    expect(focusedPaneTabKinds()).toContain("working_diff");
    expect(collectAllPanes(layout().root)).toHaveLength(1);
    expect(isSidePanelOpen(tablet)).toBe(true);
  });

  it("closes the side panel tab on the second toggle", () => {
    toggleSidePanel(tablet);
    toggleSidePanel(tablet);

    expect(tabKinds()).not.toContain("working_diff");
    expect(isSidePanelOpen(tablet)).toBe(false);
  });

  it("keeps supporting tabs in the focused pane so the tab row still lists them", () => {
    const tabId = openSupportingTab({
      isCompact: false,
      supportsPaneSplits: false,
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "files" },
      openInSidePanelByDefault: true,
    });

    expect(tabId).not.toBeNull();
    expect(paneIdHolding(tabId as string)).toBe(layout().focusedPaneId);
    expect(collectAllPanes(layout().root)).toHaveLength(1);
  });
});
