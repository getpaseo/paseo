import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { useExplorerRevealStore } from "@/file-explorer/reveal-store";
import { usePanelStore } from "@/stores/panel-store";
import {
  collectAllTabs,
  findPaneById,
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { revealFileInExplorer } from "@/workspace-tabs/reveal-file-in-explorer";

const WORKSPACE_KEY = "server-1:ws-main";
const CHECKOUT = { serverId: "server-1", cwd: "/tmp/repo", isGit: true };
const REVEAL_KEY = "server-1\u0000workspace:ws-main";

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
  usePanelStore.setState({
    mobilePanel: { target: "agent", revision: 0 },
    explorerTab: "changes",
    explorerTabByCheckout: {},
  });
  useExplorerRevealStore.setState({ requests: {} });
});

function openFocusedFileTab(path: string): string {
  const tabId = useWorkspaceLayoutStore.getState().openTab({
    workspaceKey: WORKSPACE_KEY,
    target: { kind: "file", path },
    intent: "reveal",
  });
  if (!tabId) throw new Error("file tab was not opened");
  return tabId;
}

function focusedTabIdOfFocusedPane(): string | null {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
  if (!layout) return null;
  return findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null;
}

describe("revealFileInExplorer", () => {
  it("shows desktop Explorer on Files without moving workspace focus off the file tab", () => {
    const fileTabId = openFocusedFileTab("/tmp/repo/src/app/main.ts");

    const result = revealFileInExplorer({
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: WORKSPACE_KEY,
      workspaceId: "ws-main",
      checkout: CHECKOUT,
      path: "/tmp/repo/src/app/main.ts",
    });

    expect(result).toBe("revealing");
    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const explorerPaneId = selectExplorerSidebarPaneId(state, WORKSPACE_KEY);
    const explorerPane =
      layout && explorerPaneId ? findPaneById(layout.root, explorerPaneId) : null;
    const explorerTab = layout
      ? collectAllTabs(layout.root).find((tab) => tab.tabId === explorerPane?.focusedTabId)
      : undefined;
    expect(explorerTab?.target.kind).toBe("files");
    expect(focusedTabIdOfFocusedPane()).toBe(fileTabId);
    expect(useExplorerRevealStore.getState().requests).toEqual({
      [REVEAL_KEY]: {
        path: "src/app/main.ts",
        requestId: expect.any(Number),
        createdAt: expect.any(Number),
      },
    });
  });

  it("opens the compact Explorer overlay on Files and records the request", () => {
    const result = revealFileInExplorer({
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      workspaceId: "ws-main",
      checkout: CHECKOUT,
      path: "src/index.ts",
    });

    expect(result).toBe("revealing");
    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    expect(usePanelStore.getState().explorerTab).toBe("files");
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBeUndefined();
    expect(useExplorerRevealStore.getState().requests).toEqual({
      [REVEAL_KEY]: {
        path: "src/index.ts",
        requestId: expect.any(Number),
        createdAt: expect.any(Number),
      },
    });
  });

  it("records the request before the Explorer opens, so a tree mounting on open finds it", () => {
    let requestsWhenOpened: unknown = null;
    const unsubscribe = usePanelStore.subscribe((state, previous) => {
      if (
        state.mobilePanel.target === "file-explorer" &&
        previous.mobilePanel.target !== state.mobilePanel.target
      ) {
        requestsWhenOpened = useExplorerRevealStore.getState().requests;
      }
    });

    revealFileInExplorer({
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      workspaceId: "ws-main",
      checkout: CHECKOUT,
      path: "src/index.ts",
    });
    unsubscribe();

    expect(requestsWhenOpened).toEqual({
      [REVEAL_KEY]: {
        path: "src/index.ts",
        requestId: expect.any(Number),
        createdAt: expect.any(Number),
      },
    });
  });

  it("reveals on compact layouts without a workspace layout key", () => {
    const result = revealFileInExplorer({
      isCompact: true,
      workspaceKey: null,
      workspaceId: "ws-main",
      checkout: CHECKOUT,
      path: "src/index.ts",
    });

    expect(result).toBe("revealing");
    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    expect(usePanelStore.getState().explorerTab).toBe("files");
    expect(Object.keys(useExplorerRevealStore.getState().requests)).toEqual([REVEAL_KEY]);
  });

  it("opens nothing on desktop without a workspace layout key", () => {
    const result = revealFileInExplorer({
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: null,
      workspaceId: "ws-main",
      checkout: CHECKOUT,
      path: "src/index.ts",
    });

    expect(result).toBe("unavailable");
    expect(useExplorerRevealStore.getState().requests).toEqual({});
  });

  it("gives a repeated reveal of the same path a new request id", () => {
    const input = {
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      workspaceId: "ws-main",
      checkout: CHECKOUT,
      path: "src/index.ts",
    };
    revealFileInExplorer(input);
    const first = useExplorerRevealStore.getState().requests[REVEAL_KEY]?.requestId;
    revealFileInExplorer(input);
    const second = useExplorerRevealStore.getState().requests[REVEAL_KEY]?.requestId;

    expect(first).toEqual(expect.any(Number));
    expect(second).toBe((first ?? 0) + 1);
  });

  it("opens nothing for a file outside the workspace", () => {
    const result = revealFileInExplorer({
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      workspaceId: "ws-main",
      checkout: CHECKOUT,
      path: "/etc/hosts",
    });

    expect(result).toBe("outside-workspace");
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
    expect(useExplorerRevealStore.getState().requests).toEqual({});
  });

  it("opens nothing without a workspace checkout", () => {
    const result = revealFileInExplorer({
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: WORKSPACE_KEY,
      workspaceId: "ws-main",
      checkout: null,
      path: "src/index.ts",
    });

    expect(result).toBe("unavailable");
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBeUndefined();
    expect(useExplorerRevealStore.getState().requests).toEqual({});
  });
});
