import {
  closeWorkspaceBrowser,
  openWorkspaceBrowser,
  reopenLastWorkspaceBrowser,
} from "@/workspace-tabs/browser";
import {
  isAgentBrowserTab,
  rememberWorkspaceClassicBrowser,
  openWorkspaceAgentBrowser,
  selectClassicBrowser,
} from "@/workspace-tabs/agent-browser";
import { indexedDB as fakeIndexedDb } from "fake-indexeddb";

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

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSessionStore } from "@/stores/session-store";
import { createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { getBrowserRecord, useBrowserStore } from "@/desktop/browser/store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  findPaneContainingTab,
  normalizeLayout,
  useWorkspaceLayoutStore,
  type SplitNode,
  type SplitPane,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import {
  openWorkspaceDevPreview,
  readWorkspaceDevPreviewScriptName,
} from "@/workspace-tabs/dev-preview";

globalThis.indexedDB = fakeIndexedDb;

const SERVER_ID = "server-1";
const WORKSPACE_ID = "ws-main";

const workspaceKey = buildWorkspaceTabPersistenceKey({
  serverId: SERVER_ID,
  workspaceId: WORKSPACE_ID,
}) as string;

function createTab(
  tabId: string,
  target?: WorkspaceTab["target"],
  state?: WorkspaceTab["state"],
): WorkspaceTab {
  return {
    tabId,
    target: target ?? { kind: "draft", draftId: tabId },
    createdAt: 1,
    ...(state === undefined ? {} : { state }),
  };
}

function createPane(input: {
  id: string;
  tabIds: string[];
  focusedTabId?: string | null;
  targetsByTabId?: Record<string, WorkspaceTab["target"]>;
  stateByTabId?: Record<string, WorkspaceTab["state"]>;
}): SplitNode {
  const tabs = input.tabIds.map((tabId) =>
    createTab(tabId, input.targetsByTabId?.[tabId], input.stateByTabId?.[tabId]),
  );
  return {
    kind: "pane",
    pane: {
      id: input.id,
      tabIds: input.tabIds,
      focusedTabId: input.focusedTabId ?? input.tabIds[input.tabIds.length - 1] ?? null,
      tabs,
    } as SplitPane,
  };
}

function expectGroup(node: SplitNode): Extract<SplitNode, { kind: "group" }> {
  expect(node.kind).toBe("group");
  return node as Extract<SplitNode, { kind: "group" }>;
}

function contentTabs(): WorkspaceTab[] {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  return collectAllTabs(layout.root).filter((tab) => tab.target.kind !== "new_tab");
}

function browserPreviewTabs(): WorkspaceTab[] {
  return contentTabs().filter(
    (tab) => tab.target.kind === "browser" && readWorkspaceDevPreviewScriptName(tab.state) !== null,
  );
}

function resetStores() {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    splitSizesByWorkspace: {},
    browserPaneIdByWorkspace: {},
    focusRestorationByWorkspace: {},
    sidePaneIdByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
  });
  useBrowserStore.setState({ browsersById: {}, lastClosedByWorkspace: {} });
  useSessionStore.setState({ sessions: {} });
  useSessionStore.getState().initializeSession(SERVER_ID, null);
  useSessionStore.getState().setWorkspaces(
    SERVER_ID,
    new Map([
      [
        WORKSPACE_ID,
        {
          id: WORKSPACE_ID,
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
      ],
    ]),
  );
}

function seedConversationTab(): string {
  return useWorkspaceLayoutStore.getState().openTab({
    workspaceKey,
    target: { kind: "draft", draftId: "conversation-1" },
    intent: "new",
  }) as string;
}

function groupSizes(key: string, groupId: string): number[] {
  return useWorkspaceLayoutStore.getState().splitSizesByWorkspace[key]?.[groupId] ?? [];
}

describe("workspace dev preview", () => {
  beforeEach(() => {
    resetStores();
  });

  it("opens the first preview in a full-height right column at 25/75", () => {
    const conversationTabId = seedConversationTab();

    const result = openWorkspaceDevPreview({
      workspaceKey,
      scriptName: "app",
      url: "http://localhost:3000",
    });

    if (!result.ok || !result.created) {
      throw new Error(`Expected a created preview, got ${JSON.stringify(result)}`);
    }
    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[workspaceKey];
    const root = expectGroup(layout.root);
    expect(root.group.direction).toBe("horizontal");
    expect(groupSizes(workspaceKey, root.group.id)).toEqual([0.25, 0.75]);

    const browserPaneId = state.browserPaneIdByWorkspace[workspaceKey];
    expect(findPaneById(root, browserPaneId)?.tabIds).toEqual([result.tabId]);
    const previewTab = collectAllTabs(root).find((tab) => tab.tabId === result.tabId);
    expect(previewTab?.target.kind).toBe("browser");
    expect(readWorkspaceDevPreviewScriptName(previewTab?.state)).toBe("app");
    expect(getBrowserRecord(result.browserId)?.url).toBe("http://localhost:3000");

    // The conversation keeps its selection on the left; the Explorer dock is untouched.
    const mainPane = findPaneById(root, "main");
    expect(mainPane?.tabIds).toContain(conversationTabId);
    expect(mainPane?.focusedTabId).toBe(conversationTabId);
  });

  it("reuses an open preview without duplicating it or resetting a manual resize", () => {
    const first = openWorkspaceDevPreview({
      workspaceKey,
      scriptName: "app",
      url: "http://localhost:3000",
    });
    if (!first.ok || !first.created) {
      throw new Error("Expected the first open to create the preview");
    }
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const root = expectGroup(layout.root);
    useWorkspaceLayoutStore.getState().resizeSplit(workspaceKey, root.group.id, [0.6, 0.4]);
    expect(groupSizes(workspaceKey, root.group.id)).toEqual([0.6, 0.4]);

    const second = openWorkspaceDevPreview({
      workspaceKey,
      scriptName: "app",
      url: "http://localhost:5173",
    });

    if (!second.ok) {
      throw new Error("Expected the reopen to succeed");
    }
    expect(second.created).toBe(false);
    expect(second.tabId).toBe(first.tabId);
    expect(second.browserId).toBe(first.browserId);
    expect(browserPreviewTabs()).toHaveLength(1);
    expect(Object.keys(useBrowserStore.getState().browsersById)).toHaveLength(1);
    expect(groupSizes(workspaceKey, root.group.id)).toEqual([0.6, 0.4]);
  });

  it("preserves other tabs and panes while opening the preview", () => {
    seedConversationTab();
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "terminal-1" },
      intent: "new",
    });
    const splitPaneId = useWorkspaceLayoutStore.getState().splitPaneEmpty(workspaceKey, {
      targetPaneId: "main",
      position: "right",
    });
    expect(splitPaneId).toBeTruthy();

    const result = openWorkspaceDevPreview({
      workspaceKey,
      scriptName: "app",
      url: "http://localhost:3000",
    });
    expect(result.ok).toBe(true);

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const tabTargets = collectAllTabs(layout.root)
      .filter((tab) => tab.target.kind !== "new_tab")
      .map((tab) => tab.target);
    expect(tabTargets).toContainEqual({ kind: "draft", draftId: "conversation-1" });
    expect(tabTargets).toContainEqual({ kind: "terminal", terminalId: "terminal-1" });
    const paneIds = collectAllPanes(layout.root).map((pane) => pane.id);
    expect(paneIds).toContain(splitPaneId as string);
    expect(contentTabs().filter((tab) => tab.target.kind === "browser")).toHaveLength(1);
  });

  it("preserves an occupied side pane while opening the preview in its browser pane", () => {
    seedConversationTab();
    const store = useWorkspaceLayoutStore.getState();
    const sidePaneId = store.ensureSidePane(workspaceKey)!;
    const fileId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/side.ts" },
      intent: "reveal",
      placement: { mode: "pane", paneId: sidePaneId },
    })!;

    const result = openWorkspaceDevPreview({
      workspaceKey,
      scriptName: "app",
      url: "http://localhost:3000",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected preview beside occupied side pane");
    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, sidePaneId)?.tabIds).toEqual([fileId]);
    expect(findPaneContainingTab(layout.root, result.tabId)?.id).toBe(
      state.browserPaneIdByWorkspace[workspaceKey],
    );
    expect(state.browserPaneIdByWorkspace[workspaceKey]).not.toBe(sidePaneId);
    expect(state.sidePaneIdByWorkspace[workspaceKey]).toBe(sidePaneId);
  });

  it("keeps nested ordinary side panes while creating a full-height browser column", () => {
    const nestedLayout = normalizeLayout({
      root: {
        kind: "group",
        group: {
          id: "group-root",
          direction: "horizontal",
          children: [
            createPane({ id: "main", tabIds: ["tab-main"] }),
            {
              kind: "group",
              group: {
                id: "group-vertical",
                direction: "vertical",
                children: [
                  createPane({
                    id: "side-nested",
                    tabIds: ["tab-side"],
                    targetsByTabId: {
                      "tab-side": { kind: "terminal", terminalId: "terminal-side" },
                    },
                  }),
                  createPane({ id: "lower", tabIds: ["tab-lower"] }),
                ],
                sizes: [0.5, 0.5],
              },
            },
          ],
          sizes: [1],
        },
      },
      focusedPaneId: "main",
    });
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: { [workspaceKey]: nestedLayout },
      sidePaneIdByWorkspace: { [workspaceKey]: "side-nested" },
    });

    const result = openWorkspaceDevPreview({
      workspaceKey,
      scriptName: "app",
      url: "http://localhost:3000",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected a dedicated preview column");
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, "side-nested")?.tabIds).toEqual(["tab-side"]);
    expect(findPaneById(layout.root, "lower")?.tabIds).toEqual(["tab-lower"]);
    const root = expectGroup(layout.root);
    expect(groupSizes(workspaceKey, root.group.id)).toEqual([0.25, 0.75]);
    expect(findPaneContainingTab(root, result.tabId)?.id).toBe(
      root.group.children[1].kind === "pane" ? root.group.children[1].pane.id : null,
    );
  });
  it("persists the preview marker and reveals its dedicated browser pane after reload", async () => {
    seedConversationTab();
    const opened = openWorkspaceDevPreview({
      workspaceKey,
      scriptName: "app",
      url: "http://localhost:3000",
    });
    if (!opened.ok) throw new Error("Expected preview");
    await vi.waitFor(async () =>
      expect(await AsyncStorage.getItem("workspace-layout-state")).toContain(
        "devPreviewScriptName",
      ),
    );
    const reader = createWorkspaceLayoutStore();
    await reader.persist.rehydrate();
    const restored = reader.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllTabs(restored.root).find((tab) => tab.tabId === opened.tabId)?.state).toEqual({
      devPreviewScriptName: "app",
    });
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: { [workspaceKey]: restored } });
    useWorkspaceLayoutStore.getState().moveTabToPane(workspaceKey, opened.tabId, "main");
    const paneCount = collectAllPanes(
      useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
    ).length;
    expect(
      openWorkspaceDevPreview({ workspaceKey, scriptName: "app", url: "http://localhost:5173" }),
    ).toEqual({ ...opened, created: false });
    const revealed = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(revealed.root, opened.tabId)?.focusedTabId).toBe(opened.tabId);
    expect(findPaneById(revealed.root, "main")?.tabIds).not.toContain(opened.tabId);
    expect(collectAllTabs(revealed.root).find((tab) => tab.tabId === opened.tabId)?.state).toEqual({
      devPreviewScriptName: "app",
    });
    expect(collectAllPanes(revealed.root)).toHaveLength(paneCount);
    expect(getBrowserRecord(opened.browserId)?.url).toBe("http://localhost:3000");
  });
});

describe("workspace agent browser", () => {
  beforeEach(resetStores);
  it("returns to the last classic page after selecting the dashboard directly", () => {
    seedConversationTab();
    const first = openWorkspaceBrowser({
      workspaceKey,
      url: "https://first.test",
      intent: "reveal",
    });
    const second = openWorkspaceBrowser({
      workspaceKey,
      url: "https://second.test",
      intent: "reveal",
    });
    const dashboard = openWorkspaceAgentBrowser(workspaceKey, "http://127.0.0.1:4848");
    if (!first.ok || !second.ok || !dashboard.ok) throw new Error("Expected browser pages");
    const unsubscribe = useWorkspaceLayoutStore.subscribe(() =>
      rememberWorkspaceClassicBrowser(workspaceKey),
    );
    try {
      const store = useWorkspaceLayoutStore.getState();
      store.focusTab(workspaceKey, first.tabId);
      store.focusTab(workspaceKey, dashboard.tabId);
      expect(selectClassicBrowser(contentTabs(), dashboard.tabId)?.tabId).toBe(first.tabId);
    } finally {
      unsubscribe();
    }
  });
  it("preserves the dashboard role and classic page when reopening a closed tab", async () => {
    seedConversationTab();
    const classic = openWorkspaceBrowser({
      workspaceKey,
      url: "https://classic.test",
      intent: "reveal",
    });
    const dashboard = openWorkspaceAgentBrowser(workspaceKey, "http://127.0.0.1:4848");
    if (!classic.ok || !dashboard.ok) throw new Error("Expected browser pages");
    await closeWorkspaceBrowser(
      { workspaceKey, browserId: dashboard.browserId, remember: true },
      undefined,
    );
    const reopened = reopenLastWorkspaceBrowser(workspaceKey);
    if (!reopened.ok) throw new Error("Expected reopened dashboard");
    expect(
      contentTabs()
        .filter(isAgentBrowserTab)
        .map((tab) => tab.tabId),
    ).toEqual([reopened.tabId]);
    expect(selectClassicBrowser(contentTabs(), reopened.tabId)?.tabId).toBe(classic.tabId);
    expect(openWorkspaceAgentBrowser(workspaceKey, "http://127.0.0.1:4848")).toMatchObject({
      ok: true,
      browserId: reopened.browserId,
      tabId: reopened.tabId,
      created: false,
    });
  });
  it("remembers classic selections while the dashboard is closed", async () => {
    seedConversationTab();
    const first = openWorkspaceBrowser({
      workspaceKey,
      url: "https://first.test",
      intent: "reveal",
    });
    const second = openWorkspaceBrowser({
      workspaceKey,
      url: "https://second.test",
      intent: "reveal",
    });
    if (!first.ok || !second.ok) throw new Error("Expected classic pages");
    useWorkspaceLayoutStore.getState().focusTab(workspaceKey, first.tabId);
    const dashboard = openWorkspaceAgentBrowser(workspaceKey, "http://127.0.0.1:4848");
    if (!dashboard.ok) throw new Error("Expected dashboard");
    const unsubscribe = useWorkspaceLayoutStore.subscribe(() =>
      rememberWorkspaceClassicBrowser(workspaceKey),
    );
    try {
      await closeWorkspaceBrowser(
        { workspaceKey, browserId: dashboard.browserId, remember: true },
        undefined,
      );
      useWorkspaceLayoutStore.getState().focusTab(workspaceKey, second.tabId);
      const reopened = reopenLastWorkspaceBrowser(workspaceKey);
      if (!reopened.ok) throw new Error("Expected reopened dashboard");
      expect(selectClassicBrowser(contentTabs(), reopened.tabId)?.tabId).toBe(second.tabId);
    } finally {
      unsubscribe();
    }
  });
  it("reuses its dashboard tab and preserves the last classic page", () => {
    seedConversationTab();
    const first = openWorkspaceBrowser({
      workspaceKey,
      url: "https://first.test",
      intent: "reveal",
    });
    const second = openWorkspaceBrowser({
      workspaceKey,
      url: "https://second.test",
      intent: "reveal",
    });
    if (!first.ok || !second.ok) throw new Error("Expected classic pages");
    const dashboard = openWorkspaceAgentBrowser(workspaceKey, "http://127.0.0.1:4848");
    if (!dashboard.ok) throw new Error("Expected dashboard");
    expect(openWorkspaceAgentBrowser(workspaceKey, "http://127.0.0.1:4848")).toMatchObject({
      ok: true,
      tabId: dashboard.tabId,
      browserId: dashboard.browserId,
      created: false,
    });
    const tabs = contentTabs();
    expect(tabs.filter(isAgentBrowserTab)).toHaveLength(1);
    expect(selectClassicBrowser(tabs, dashboard.tabId)?.tabId).toBe(second.tabId);
    expect(getBrowserRecord(first.browserId)?.url).toBe("https://first.test");
    expect(getBrowserRecord(second.browserId)?.url).toBe("https://second.test");
    useWorkspaceLayoutStore.getState().hideBrowserPane(workspaceKey);
    expect(openWorkspaceAgentBrowser(workspaceKey, "http://127.0.0.1:4848")).toMatchObject({
      ok: true,
      created: false,
    });
    expect(contentTabs().filter(isAgentBrowserTab)).toHaveLength(1);
  });
});
