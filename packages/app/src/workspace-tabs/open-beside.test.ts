import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import {
  collectAllPanes,
  DEFAULT_PANE_ID,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { openWorkspaceTargetAtLocation } from "@/workspace-tabs/open-beside";

const WORKSPACE_KEY = "server-1:workspace-1";

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
});

describe("openWorkspaceTargetAtLocation", () => {
  it("opens a browser tab in the main panel", () => {
    const sideTabId = openWorkspaceTargetAtLocation({
      isCompact: false,
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "browser", browserId: "browser-side-first" },
      location: "side",
    });
    expect(sideTabId).toBeTruthy();

    const tabId = openWorkspaceTargetAtLocation({
      isCompact: false,
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
      isCompact: false,
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
        isCompact: false,
        workspaceKey: WORKSPACE_KEY,
        target: { kind: "browser", browserId },
        location: "main",
      });
    }
    function openOnSide(browserId: string) {
      return openWorkspaceTargetAtLocation({
        isCompact: false,
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
