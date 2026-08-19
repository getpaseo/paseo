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

const paneSplits = vi.hoisted(() => ({ supported: true }));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  supportsDesktopPaneSplits: () => paneSplits.supported,
}));

import { usePanelStore } from "@/stores/panel-store";
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  openExplorerSurface,
  openWorkspaceTabBeside,
  isExplorerSurfaceOpen,
  toggleExplorerSurface,
} from "@/workspace-tabs/explorer-surface";

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

beforeEach(() => {
  paneSplits.supported = true;
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerPaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
  usePanelStore.setState({ mobilePanel: { target: "agent", revision: 0 } });
});

describe("compact surface", () => {
  const compact = { isCompact: true, workspaceKey: WORKSPACE_KEY, checkout: CHECKOUT };

  it("opens and closes the overlay without touching the layout", () => {
    openExplorerSurface({ ...compact, view: "files" });

    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    expect(usePanelStore.getState().explorerTab).toBe("files");
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBeUndefined();

    toggleExplorerSurface(compact);
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  });

  it("reports the overlay state, not the layout state", () => {
    expect(isExplorerSurfaceOpen({ isCompact: true, workspaceKey: WORKSPACE_KEY })).toBe(false);
    toggleExplorerSurface(compact);
    expect(isExplorerSurfaceOpen({ isCompact: true, workspaceKey: WORKSPACE_KEY })).toBe(true);
  });
});

describe("non-compact with splits", () => {
  const wide = { isCompact: false, workspaceKey: WORKSPACE_KEY, checkout: CHECKOUT };

  it("seeds a Changes tab in a dedicated explorer pane", () => {
    toggleExplorerSurface(wide);

    expect(tabKinds()).toContain("working_diff");
    expect(collectAllPanes(layout().root).length).toBeGreaterThan(1);
    expect(isExplorerSurfaceOpen(wide)).toBe(true);
  });

  it("hides the pane on the second toggle and restores it on the third", () => {
    toggleExplorerSurface(wide);
    toggleExplorerSurface(wide);
    expect(isExplorerSurfaceOpen(wide)).toBe(false);

    toggleExplorerSurface(wide);
    expect(isExplorerSurfaceOpen(wide)).toBe(true);
    // Restoring must not stack a second Changes tab.
    expect(tabKinds().filter((kind) => kind === "working_diff")).toHaveLength(1);
  });

  it("leaves the compact overlay alone", () => {
    toggleExplorerSurface(wide);
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  });

  it("opens files beside the current tab, in the explorer pane", () => {
    const tabId = openWorkspaceTabBeside({
      isCompact: false,
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "files" },
    });

    expect(tabId).not.toBeNull();
    const explorerPaneId =
      useWorkspaceLayoutStore.getState().explorerPaneIdByWorkspace[WORKSPACE_KEY];
    expect(findPaneContainingTab(layout().root, tabId!)?.id).toBe(explorerPaneId);
  });
});

describe("non-compact without splits", () => {
  const tablet = { isCompact: false, workspaceKey: WORKSPACE_KEY, checkout: CHECKOUT };

  beforeEach(() => {
    paneSplits.supported = false;
  });

  it("opens the explorer as a tab in the focused pane, never a second pane", () => {
    toggleExplorerSurface(tablet);

    expect(focusedPaneTabKinds()).toContain("working_diff");
    expect(collectAllPanes(layout().root)).toHaveLength(1);
    expect(isExplorerSurfaceOpen(tablet)).toBe(true);
  });

  it("closes the explorer tab on the second toggle", () => {
    toggleExplorerSurface(tablet);
    toggleExplorerSurface(tablet);

    expect(tabKinds()).not.toContain("working_diff");
    expect(isExplorerSurfaceOpen(tablet)).toBe(false);
  });

  it("keeps side-opened files in the focused pane so the tab row still lists them", () => {
    const tabId = openWorkspaceTabBeside({
      isCompact: false,
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "files" },
    });

    expect(tabId).not.toBeNull();
    expect(findPaneContainingTab(layout().root, tabId!)?.id).toBe(layout().focusedPaneId);
    expect(collectAllPanes(layout().root)).toHaveLength(1);
  });
});
