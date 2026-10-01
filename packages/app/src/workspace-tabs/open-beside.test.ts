import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import {
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
    const tabId = openWorkspaceTargetAtLocation({
      isCompact: false,
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "browser", browserId: "browser-main" },
      location: "main",
    });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    if (!tabId || !layout) throw new Error("Expected the browser tab to open");
    expect(findPaneContainingTab(layout.root, tabId)?.id).toBe(DEFAULT_PANE_ID);
    expect(state.sidePaneIdByWorkspace[WORKSPACE_KEY]).toBeUndefined();
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
    if (!tabId || !layout || !sidePaneId) {
      throw new Error("Expected the browser tab to open in a side pane");
    }
    expect(findPaneContainingTab(layout.root, tabId)?.id).toBe(sidePaneId);
  });
});
