import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { DEFAULT_APP_SETTINGS } from "@/hooks/use-settings";
import { setPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import {
  collectAllPanes,
  collectAllTabs,
  DEFAULT_PANE_ID,
  findPaneById,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  openPreferredWorkspacePreview,
  openPreferredWorkspaceTarget,
  openWorkspaceTargetAtLocation,
  openWorkspaceTargetBeside,
} from "@/workspace-tabs/open-beside";

const WORKSPACE_KEY = "server-1:workspace-1";

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutMode: "split-panes",
    sheetsByWorkspace: {},
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
});

describe("openPreferredWorkspacePreview", () => {
  it("opens a compact file preview in the sheet instead of replacing the active file tab", () => {
    const store = useWorkspaceLayoutStore.getState();
    const fileTabId = store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "src/open.ts" },
      intent: "reveal",
    });
    store.setLayoutMode("compact");

    const tabId = openPreferredWorkspacePreview({
      workspaceKey: WORKSPACE_KEY,
      serverId: "server-1",
      workspaceId: "workspace-1",
      explorerSidebarPaneId: "explorer",
      lastMainPaneId: "main",
      target: { kind: "file", path: "src/preview.ts" },
      source: "explorerFiles",
      preferences: DEFAULT_APP_SETTINGS.openInSidePane,
    });

    const state = useWorkspaceLayoutStore.getState();
    expect(state.sheetsByWorkspace[WORKSPACE_KEY]?.at(-1)?.tab).toMatchObject({
      tabId,
      target: { kind: "file", path: "src/preview.ts" },
    });
    const root = state.layoutByWorkspace[WORKSPACE_KEY].root;
    expect(findPaneById(root, "main")?.tabIds).toEqual([fileTabId]);
    expect(collectAllTabs(root).find((tab) => tab.tabId === fileTabId)?.target).toEqual({
      kind: "file",
      path: "src/open.ts",
    });
  });
});

describe("previews under a sheet with unsaved work", () => {
  const sheetTarget = { kind: "file" as const, path: "src/draft.ts" };
  let sheetTabId: string | null = null;

  afterEach(() => {
    if (sheetTabId) {
      setPanelInstanceAttributes(
        { serverId: "server-1", workspaceId: "workspace-1", tabId: sheetTabId },
        { modified: false },
      );
    }
    sheetTabId = null;
  });

  function previewFile(path: string): string | null {
    return openPreferredWorkspacePreview({
      workspaceKey: WORKSPACE_KEY,
      serverId: "server-1",
      workspaceId: "workspace-1",
      explorerSidebarPaneId: "explorer",
      lastMainPaneId: "main",
      target: { kind: "file", path },
      source: "explorerFiles",
      preferences: DEFAULT_APP_SETTINGS.openInSidePane,
    });
  }

  it("stacks link previews over the sheet instead of dropping its unsaved work", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "terminal", terminalId: "term-1" },
      intent: "reveal",
    });
    store.setLayoutMode("compact");
    sheetTabId = store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: sheetTarget,
      intent: "reveal",
    });
    setPanelInstanceAttributes(
      { serverId: "server-1", workspaceId: "workspace-1", tabId: sheetTabId ?? "" },
      { modified: true },
    );

    previewFile("src/first.ts");
    previewFile("src/second.ts");

    const state = useWorkspaceLayoutStore.getState();
    expect(state.sheetsByWorkspace[WORKSPACE_KEY]?.map((sheet) => sheet.tab.target)).toEqual([
      sheetTarget,
      { kind: "file", path: "src/first.ts" },
      { kind: "file", path: "src/second.ts" },
    ]);
    const root = state.layoutByWorkspace[WORKSPACE_KEY].root;
    expect(findPaneById(root, "main")?.tabIds).toHaveLength(1);
  });
});

describe("opening beside", () => {
  const sidePreference = { ...DEFAULT_APP_SETTINGS.openInSidePane, subagents: true };

  function openSubagentWithSidePreference(): string | null {
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "src/open.ts" },
      intent: "reveal",
    });
    return openPreferredWorkspaceTarget({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "src/subagent.ts" },
      source: "subagents",
      preferences: sidePreference,
    });
  }

  function paneIdHolding(tabId: string | null): string | undefined {
    const root = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY].root;
    return collectAllPanes(root).find((pane) => pane.tabIds.includes(tabId ?? ""))?.id;
  }

  it("follows the side preference where the workspace renders split panes", () => {
    useWorkspaceLayoutStore.getState().setLayoutMode("split-panes");

    const tabId = openSubagentWithSidePreference();

    const sidePaneId = useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY];
    expect(sidePaneId).toEqual(expect.any(String));
    expect(paneIdHolding(tabId)).toBe(sidePaneId);
  });

  it("keeps a single-pane workspace in one pane despite the side preference", () => {
    useWorkspaceLayoutStore.getState().setLayoutMode("single-pane");

    const preferredTabId = openSubagentWithSidePreference();
    const besideTabId = openWorkspaceTargetBeside({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "src/beside.ts" },
    });

    expect(useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY]).toBeFalsy();
    expect(paneIdHolding(preferredTabId)).toBe("main");
    expect(paneIdHolding(besideTabId)).toBe("main");
  });
});

describe("openWorkspaceTargetAtLocation", () => {
  it("opens a browser tab in the main panel", () => {
    const sideTabId = openWorkspaceTargetAtLocation({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "browser", browserId: "browser-side-first" },
      location: "side",
    });
    expect(sideTabId).toBeTruthy();

    const tabId = openWorkspaceTargetAtLocation({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "browser", browserId: "browser-main" },
      location: "main",
    });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    expect(tabId).toBeTruthy();
    expect(findPaneContainingTab(layout!.root, sideTabId!)?.id).not.toBe(DEFAULT_PANE_ID);
    expect(findPaneContainingTab(layout!.root, tabId!)?.id).toBe(DEFAULT_PANE_ID);
  });

  it("opens a browser tab on the side", () => {
    const tabId = openWorkspaceTargetAtLocation({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "browser", browserId: "browser-side" },
      location: "side",
    });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const sidePaneId = state.sidePaneIdByWorkspace[WORKSPACE_KEY];
    expect(tabId).toBeTruthy();
    expect(sidePaneId).toBeTruthy();
    expect(findPaneContainingTab(layout!.root, tabId!)?.id).toBe(sidePaneId);
  });

  describe("with a split the user already made", () => {
    function openInMain(browserId: string) {
      return openWorkspaceTargetAtLocation({
        workspaceKey: WORKSPACE_KEY,
        target: { kind: "browser", browserId },
        location: "main",
      });
    }
    function openOnSide(browserId: string) {
      return openWorkspaceTargetAtLocation({
        workspaceKey: WORKSPACE_KEY,
        target: { kind: "browser", browserId },
        location: "side",
      });
    }
    function layout() {
      return useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]!;
    }

    it("opens in the pane to the right of the focused pane", () => {
      openInMain("browser-main");
      const store = useWorkspaceLayoutStore.getState();
      const rightPaneId = store.splitPaneEmpty(WORKSPACE_KEY, {
        targetPaneId: DEFAULT_PANE_ID,
        position: "right",
      })!;
      store.focusPane(WORKSPACE_KEY, DEFAULT_PANE_ID);
      const paneCount = collectAllPanes(layout().root).length;

      const tabId = openOnSide("browser-side");

      expect(findPaneContainingTab(layout().root, tabId!)?.id).toBe(rightPaneId);
      expect(collectAllPanes(layout().root)).toHaveLength(paneCount);
      expect(useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY]).toBe(
        rightPaneId,
      );
    });

    it("splits anew when the existing split is below, not beside", () => {
      openInMain("browser-main");
      const store = useWorkspaceLayoutStore.getState();
      const belowPaneId = store.splitPaneEmpty(WORKSPACE_KEY, {
        targetPaneId: DEFAULT_PANE_ID,
        position: "bottom",
      })!;
      store.focusPane(WORKSPACE_KEY, DEFAULT_PANE_ID);

      const tabId = openOnSide("browser-side");

      const paneId = findPaneContainingTab(layout().root, tabId!)?.id;
      expect(paneId).not.toBe(belowPaneId);
      expect(paneId).not.toBe(DEFAULT_PANE_ID);
    });

    it("splits anew when the focused pane is already the rightmost", () => {
      openInMain("browser-main");
      const store = useWorkspaceLayoutStore.getState();
      const rightPaneId = store.splitPaneEmpty(WORKSPACE_KEY, {
        targetPaneId: DEFAULT_PANE_ID,
        position: "right",
      })!;
      store.focusPane(WORKSPACE_KEY, rightPaneId);

      const tabId = openOnSide("browser-side");

      const paneId = findPaneContainingTab(layout().root, tabId!)?.id;
      expect(paneId).not.toBe(rightPaneId);
      expect(paneId).not.toBe(DEFAULT_PANE_ID);
    });
  });
});
