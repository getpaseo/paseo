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
  normalizeLayout,
  useWorkspaceLayoutStore,
  type SplitNode,
  type SplitPane,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import {
  findWorkspaceDevPreview,
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
  useBrowserStore.setState({ browsersById: {} });
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

    const sidePaneId = state.sidePaneIdByWorkspace[workspaceKey];
    expect(sidePaneId).toBeTruthy();
    const sidePane = findPaneById(root, sidePaneId);
    expect(sidePane?.tabIds).toEqual([result.tabId]);
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

  it("refuses a layout whose side pane is not a full-height column", () => {
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

    expect(result).toEqual({ ok: false, reason: "no-full-height-column" });
    expect(Object.keys(useBrowserStore.getState().browsersById)).toHaveLength(0);
    expect(browserPreviewTabs()).toHaveLength(0);
    expect(findWorkspaceDevPreview({ workspaceKey, scriptName: "app" })).toBeNull();
  });
  it("persists the preview marker and reveals it where the user moved it after reload", async () => {
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
    expect(findPaneById(revealed.root, "main")?.focusedTabId).toBe(opened.tabId);
    expect(collectAllTabs(revealed.root).find((tab) => tab.tabId === opened.tabId)?.state).toEqual({
      devPreviewScriptName: "app",
    });
    expect(collectAllPanes(revealed.root)).toHaveLength(paneCount);
    expect(getBrowserRecord(opened.browserId)?.url).toBe("http://localhost:3000");
  });
});
