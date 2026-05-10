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

import type { WorkspaceTab } from "@/stores/workspace-tabs-store";
import {
  buildWorkspaceTabPersistenceKey,
  collectAllPanes,
  collectAllTabs,
  createWorkspaceLayoutStore,
  createDefaultLayout,
  findPaneById,
  findPaneContainingTab,
  getFocusedBrowserId,
  getTreeDepth,
  insertSplit,
  removePaneFromTree,
  removeTabFromTree,
  type SplitNode,
  type SplitPane,
} from "@/stores/workspace-layout-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "ws-main";

function createDeterministicWorkspaceLayoutIds() {
  let values: string[] = [];
  let fallbackIndex = 0;

  function nextValue(): string {
    const value = values.shift();
    if (value) {
      return value;
    }
    fallbackIndex += 1;
    return `generated-${fallbackIndex}`;
  }

  return {
    useValues: (nextValues: string[]) => {
      values = nextValues.slice();
      fallbackIndex = 0;
    },
    reset: () => {
      values = [];
      fallbackIndex = 0;
    },
    createNodeId: (prefix: "pane" | "group") => `${prefix}_${nextValue()}`,
    createFocusRestorationToken: () => `workspace-focus-${nextValue()}`,
  };
}

const workspaceLayoutIds = createDeterministicWorkspaceLayoutIds();
const workspaceLayoutStore = createWorkspaceLayoutStore(workspaceLayoutIds);

function useWorkspaceLayoutIds(...values: string[]) {
  workspaceLayoutIds.useValues(values);
}

function createTab(tabId: string, target?: WorkspaceTab["target"]): WorkspaceTab {
  return {
    tabId,
    target: target ?? { kind: "draft", draftId: tabId },
    createdAt: 1,
  };
}

function createPane(input: {
  id: string;
  tabIds: string[];
  focusedTabId?: string | null;
  targetsByTabId?: Record<string, WorkspaceTab["target"]>;
}): SplitNode {
  const tabs = input.tabIds.map((tabId) => createTab(tabId, input.targetsByTabId?.[tabId]));
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

function createWorkspaceKey(): string {
  const key = buildWorkspaceTabPersistenceKey({
    serverId: SERVER_ID,
    workspaceId: WORKSPACE_ID,
  });
  expect(key).toBeTruthy();
  return key as string;
}

function expectGroup(node: SplitNode): Extract<SplitNode, { kind: "group" }> {
  expect(node.kind).toBe("group");
  return node as Extract<SplitNode, { kind: "group" }>;
}

describe("workspace-layout-store helpers", () => {
  it("finds panes and tabs across nested groups", () => {
    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.4, 0.6],
        children: [
          createPane({ id: "left", tabIds: ["tab-a", "tab-b"], focusedTabId: "tab-a" }),
          {
            kind: "group",
            group: {
              id: "group-right",
              direction: "vertical",
              sizes: [0.5, 0.5],
              children: [
                createPane({ id: "top-right", tabIds: ["tab-c"] }),
                createPane({ id: "bottom-right", tabIds: ["tab-d"] }),
              ],
            },
          },
        ],
      },
    };

    expect(findPaneById(root, "top-right")?.tabIds).toEqual(["tab-c"]);
    expect(findPaneContainingTab(root, "tab-b")?.id).toBe("left");
    expect(getTreeDepth(root)).toBe(3);
    expect(collectAllPanes(root).map((pane) => pane.id)).toEqual([
      "left",
      "top-right",
      "bottom-right",
    ]);
    expect(collectAllTabs(root).map((tab) => tab.tabId)).toEqual([
      "tab-a",
      "tab-b",
      "tab-c",
      "tab-d",
    ]);
  });

  it("derives the focused browser id from the focused pane active tab", () => {
    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.5, 0.5],
        children: [
          createPane({
            id: "left",
            tabIds: ["agent-a", "browser-a"],
            focusedTabId: "browser-a",
            targetsByTabId: {
              "agent-a": { kind: "agent", agentId: "agent-a" },
              "browser-a": { kind: "browser", browserId: "browser-a-id" },
            },
          }),
          createPane({
            id: "right",
            tabIds: ["browser-b"],
            focusedTabId: "browser-b",
            targetsByTabId: {
              "browser-b": { kind: "browser", browserId: "browser-b-id" },
            },
          }),
        ],
      },
    };

    expect(getFocusedBrowserId({ root, focusedPaneId: "left" })).toBe("browser-a-id");
    expect(getFocusedBrowserId({ root, focusedPaneId: "right" })).toBe("browser-b-id");
  });

  it("returns null when the focused pane active tab is not a browser", () => {
    const root = createPane({
      id: "main",
      tabIds: ["browser-a", "agent-a"],
      focusedTabId: "agent-a",
      targetsByTabId: {
        "browser-a": { kind: "browser", browserId: "browser-a-id" },
        "agent-a": { kind: "agent", agentId: "agent-a" },
      },
    });

    expect(getFocusedBrowserId({ root, focusedPaneId: "main" })).toBeNull();
  });
});

describe("workspace-layout-store tree transforms", () => {
  beforeEach(() => {
    workspaceLayoutIds.reset();
  });

  it("insertSplit wraps root-level same-direction splits in a nested group", () => {
    useWorkspaceLayoutIds(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.25, 0.75],
        children: [
          createPane({ id: "left", tabIds: ["tab-a"] }),
          createPane({ id: "right", tabIds: ["tab-b", "tab-c"] }),
        ],
      },
    };

    const nextRoot = insertSplit(root, "right", "tab-c", "right", workspaceLayoutIds.createNodeId);
    const nextGroup = expectGroup(nextRoot);
    const nestedGroup = expectGroup(nextGroup.group.children[1]);

    expect(nextGroup.group.direction).toBe("horizontal");
    expect(nextGroup.group.children).toHaveLength(2);
    expect(nextGroup.group.sizes).toEqual([0.25, 0.75]);
    expect(nestedGroup.group.id).toBe("group_22222222-2222-2222-2222-222222222222");
    expect(nestedGroup.group.direction).toBe("horizontal");
    expect(nestedGroup.group.sizes).toEqual([0.5, 0.5]);
    expect(collectAllPanes(nextRoot).map((pane) => pane.id)).toEqual([
      "left",
      "right",
      "pane_11111111-1111-1111-1111-111111111111",
    ]);
    expect(findPaneById(nextRoot, "right")?.tabIds).toEqual(["tab-b"]);
    expect(findPaneById(nextRoot, "pane_11111111-1111-1111-1111-111111111111")?.tabIds).toEqual([
      "tab-c",
    ]);
  });

  it("removePaneFromTree unwraps single-child groups and renormalizes siblings", () => {
    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.2, 0.8],
        children: [
          createPane({ id: "left", tabIds: ["tab-a"] }),
          {
            kind: "group",
            group: {
              id: "group-right",
              direction: "vertical",
              sizes: [0.5, 0.5],
              children: [
                createPane({ id: "top-right", tabIds: ["tab-b"] }),
                createPane({ id: "bottom-right", tabIds: ["tab-c"] }),
              ],
            },
          },
        ],
      },
    };

    const nextRoot = removePaneFromTree(root, "top-right");
    const nextGroup = expectGroup(nextRoot);

    expect(nextGroup.group.sizes).toEqual([0.2, 0.8]);
    expect(collectAllPanes(nextRoot).map((pane) => pane.id)).toEqual(["left", "bottom-right"]);
    expect(nextGroup.group.children[1]).toEqual(
      createPane({ id: "bottom-right", tabIds: ["tab-c"] }),
    );
  });

  it("removeTabFromTree collapses empty panes but keeps the final root pane", () => {
    const splitRoot: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.5, 0.5],
        children: [
          createPane({ id: "left", tabIds: ["tab-a"] }),
          createPane({ id: "right", tabIds: ["tab-b"] }),
        ],
      },
    };

    const collapsed = removeTabFromTree(splitRoot, "tab-a");
    expect(collapsed).toEqual(createPane({ id: "right", tabIds: ["tab-b"] }));

    const singlePaneRoot = createPane({ id: "main", tabIds: ["tab-a"] });
    const emptied = removeTabFromTree(singlePaneRoot, "tab-a");
    expect(emptied).toEqual(createPane({ id: "main", tabIds: [], focusedTabId: null }));
  });
});

describe("workspace-layout-store actions", () => {
  beforeEach(() => {
    workspaceLayoutIds.reset();
    workspaceLayoutStore.setState({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
      pinnedAgentIdsByWorkspace: {},
      hiddenAgentIdsByWorkspace: {},
      focusRestorationByWorkspace: {},
    });
  });

  it("opens tabs into the focused pane and focuses duplicate opens instead of creating them", () => {
    useWorkspaceLayoutIds("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/a.ts",
    });
    const secondTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    expect(splitPaneId).toBe("pane_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

    store.focusPane(workspaceKey, "main");
    const duplicateTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstTabId).toBe("file_/repo/worktree/a.ts");
    expect(secondTabId).toBe("file_/repo/worktree/b.ts");
    expect(duplicateTabId).toBe(secondTabId);
    expect(layout.focusedPaneId).toBe("pane_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(collectAllTabs(layout.root).map((tab) => tab.tabId)).toEqual([
      "file_/repo/worktree/a.ts",
      "file_/repo/worktree/b.ts",
    ]);
  });

  it("openTabInBackground inserts a tab without stealing focus", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const agentTabId = store.openTabFocused(workspaceKey, { kind: "agent", agentId: "agent-1" });
    const setupTabId = store.openTabInBackground(workspaceKey, {
      kind: "setup",
      workspaceId: "ws-main",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layout.root, "main")!;

    expect(agentTabId).toBe("agent_agent-1");
    expect(setupTabId).toBe("setup_ws-main");
    expect(pane.tabIds).toEqual([agentTabId, setupTabId]);
    expect(pane.focusedTabId).toBe(agentTabId);
    expect(layout.focusedPaneId).toBe("main");
  });

  it("openTabInBackground on an existing target is a no-op", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/a.ts",
    });
    const secondTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const duplicateTabId = store.openTabInBackground(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/a.ts",
    });
    const layoutAfter = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layoutAfter.root, "main")!;

    expect(duplicateTabId).toBe(firstTabId);
    expect(pane.tabIds).toEqual([firstTabId, secondTabId]);
    expect(pane.focusedTabId).toBe(secondTabId);
  });

  it("unfocuses and restores the previous focused pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "agent-1" });
    const token = store.unfocusPane(workspaceKey);
    expect(token).toBeTruthy();
    expect(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId,
    ).toBeNull();

    store.restorePaneFocus(workspaceKey, token!);
    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId).toBe(
      "main",
    );
  });

  it("does not restore stale focus after another pane is focused", () => {
    useWorkspaceLayoutIds("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    store.splitPane(workspaceKey, {
      tabId: firstTabId!,
      targetPaneId: "main",
      position: "right",
    });
    store.focusPane(workspaceKey, "main");

    const token = store.unfocusPane(workspaceKey);
    store.focusPane(workspaceKey, "pane_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    store.restorePaneFocus(workspaceKey, token!);

    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId).toBe(
      "pane_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );
  });

  it("waits for nested focus restorations before restoring", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "agent-1" });
    const outerToken = store.unfocusPane(workspaceKey);
    const innerToken = store.unfocusPane(workspaceKey);

    store.restorePaneFocus(workspaceKey, outerToken!);
    expect(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId,
    ).toBeNull();

    store.restorePaneFocus(workspaceKey, innerToken!);
    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId).toBe(
      "main",
    );
  });

  it("openTab creates distinct draft tabs for repeated Cmd+T/new-tab opens", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    const secondTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-2" });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstTabId).toBe("draft-1");
    expect(secondTabId).toBe("draft-2");
    expect(firstTabId).not.toBe(secondTabId);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([firstTabId, secondTabId]);
    expect(collectAllTabs(layout.root)).toEqual([
      {
        tabId: firstTabId,
        target: { kind: "draft", draftId: "draft-1" },
        createdAt: expect.any(Number),
      },
      {
        tabId: secondTabId,
        target: { kind: "draft", draftId: "draft-2" },
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("splitPaneEmpty plus openTab opens a draft tab in the new pane", () => {
    useWorkspaceLayoutIds("77777777-7777-7777-7777-777777777777");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    const newPaneId = store.splitPaneEmpty(workspaceKey, {
      targetPaneId: "main",
      position: "right",
    });
    const draftTabId = store.openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: "draft-split",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(newPaneId).toBe("pane_77777777-7777-7777-7777-777777777777");
    expect(draftTabId).toBe("draft-split");
    expect(layout.focusedPaneId).toBe(newPaneId);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual(["file_/repo/worktree/a.ts"]);
    expect(findPaneById(layout.root, newPaneId)?.tabIds).toEqual([draftTabId!]);
    expect(findPaneById(layout.root, newPaneId)?.focusedTabId).toBe(draftTabId);
  });

  it("focusTab moves workspace focus to the pane containing the tab", () => {
    useWorkspaceLayoutIds("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const fileTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/a.ts",
    });
    const terminalTabId = store.openTabFocused(workspaceKey, {
      kind: "terminal",
      terminalId: "term-1",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: terminalTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.focusTab(workspaceKey, fileTabId!);
    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout.focusedPaneId).toBe("main");

    store.focusTab(workspaceKey, terminalTabId!);
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;
    expect(splitPaneId).toBe("pane_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(layout.focusedPaneId).toBe(splitPaneId);
    expect(findPaneById(layout.root, splitPaneId)?.focusedTabId).toBe(terminalTabId);
  });

  it("convertDraftToAgent replaces the draft tab with a canonical agent tab in the same pane", () => {
    useWorkspaceLayoutIds("12121212-1212-1212-1212-121212121212");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    const secondTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-2" });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    const nextTabId = store.convertDraftToAgent(workspaceKey, secondTabId!, "agent-1");
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const splitPane = findPaneById(layout.root, splitPaneId);
    const convertedTab = collectAllTabs(layout.root).find((tab) => tab.tabId === nextTabId);

    expect(splitPaneId).toBe("pane_12121212-1212-1212-1212-121212121212");
    expect(nextTabId).toBe("agent_agent-1");
    expect(splitPane?.tabIds).toEqual(["agent_agent-1"]);
    expect(findPaneContainingTab(layout.root, "agent_agent-1")?.id).toBe(splitPaneId);
    expect(convertedTab).toEqual({
      tabId: "agent_agent-1",
      target: { kind: "agent", agentId: "agent-1" },
      createdAt: expect.any(Number),
    });
  });

  it("retargetTab keeps a draft tab in place while updating its target", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: "draft-retarget",
    });
    const nextTabId = store.retargetTab(workspaceKey, draftTabId!, {
      kind: "file",
      path: "/repo/worktree/retargeted.ts",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(draftTabId).toBe("draft-retarget");
    expect(nextTabId).toBe(draftTabId);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([draftTabId!]);
    expect(collectAllTabs(layout.root)).toEqual([
      {
        tabId: draftTabId!,
        target: { kind: "file", path: "/repo/worktree/retargeted.ts" },
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("retargetTab closes a draft tab and focuses the existing canonical target tab", () => {
    useWorkspaceLayoutIds("55555555-5555-5555-5555-555555555555");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const existingFileTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/existing.ts",
    });
    const draftTabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-dup" });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: draftTabId!,
      targetPaneId: "main",
      position: "right",
    });
    const secondDraftTabId = store.openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: "draft-dup-2",
    });

    const nextTabId = store.retargetTab(workspaceKey, secondDraftTabId!, {
      kind: "file",
      path: "/repo/worktree/existing.ts",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(existingFileTabId).toBe("file_/repo/worktree/existing.ts");
    expect(draftTabId).toBe("draft-dup");
    expect(splitPaneId).toBe("pane_55555555-5555-5555-5555-555555555555");
    expect(nextTabId).toBe(existingFileTabId);
    expect(collectAllTabs(layout.root).map((tab) => tab.tabId)).toEqual([
      existingFileTabId!,
      draftTabId!,
    ]);
    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(existingFileTabId);
  });

  it("retargetTab closes a draft tab and focuses an existing matching target tab", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstDraftTabId = store.openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: "draft-agent-1",
    });
    const firstAgentTabId = store.retargetTab(workspaceKey, firstDraftTabId!, {
      kind: "agent",
      agentId: "agent-1",
    });
    const secondDraftTabId = store.openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: "draft-agent-2",
    });

    const nextTabId = store.retargetTab(workspaceKey, secondDraftTabId!, {
      kind: "agent",
      agentId: "agent-1",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstAgentTabId).toBe(firstDraftTabId);
    expect(nextTabId).toBe(firstDraftTabId);
    expect(collectAllTabs(layout.root)).toEqual([
      {
        tabId: firstDraftTabId!,
        target: { kind: "agent", agentId: "agent-1" },
        createdAt: expect.any(Number),
      },
    ]);
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(firstDraftTabId);
  });

  it("reorderTabs reorders tabs within the focused pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/a.ts",
    });
    const secondTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const thirdTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/c.ts",
    });

    store.reorderTabs(workspaceKey, [thirdTabId!, firstTabId!]);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(findPaneById(layout.root, "main")).toEqual({
      id: "main",
      tabIds: [thirdTabId!, firstTabId!, secondTabId!],
      focusedTabId: thirdTabId,
      tabs: [
        {
          tabId: thirdTabId,
          target: { kind: "file", path: "/repo/worktree/c.ts" },
          createdAt: expect.any(Number),
        },
        {
          tabId: firstTabId,
          target: { kind: "file", path: "/repo/worktree/a.ts" },
          createdAt: expect.any(Number),
        },
        {
          tabId: secondTabId,
          target: { kind: "file", path: "/repo/worktree/b.ts" },
          createdAt: expect.any(Number),
        },
      ],
    });
  });

  it("reorderTabsInPane reorders tabs in the requested pane without changing focused pane", () => {
    useWorkspaceLayoutIds("34343434-3434-3434-3434-343434343434");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const thirdTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/c.ts",
    });
    const fourthTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/d.ts",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: thirdTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.moveTabToPane(workspaceKey, fourthTabId!, splitPaneId!);
    store.focusPane(workspaceKey, "main");
    store.reorderTabsInPane(workspaceKey, splitPaneId!, [fourthTabId!, thirdTabId!]);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(splitPaneId).toBe("pane_34343434-3434-3434-3434-343434343434");
    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, splitPaneId)).toEqual({
      id: splitPaneId,
      tabIds: [fourthTabId!, thirdTabId!],
      focusedTabId: fourthTabId,
      tabs: [
        {
          tabId: fourthTabId,
          target: { kind: "file", path: "/repo/worktree/d.ts" },
          createdAt: expect.any(Number),
        },
        {
          tabId: thirdTabId,
          target: { kind: "file", path: "/repo/worktree/c.ts" },
          createdAt: expect.any(Number),
        },
      ],
    });
  });

  it("focusPane switches workspace focus to a different pane", () => {
    useWorkspaceLayoutIds("56565656-5656-5656-5656-565656565656");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    const secondTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.focusPane(workspaceKey, "main");
    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout.focusedPaneId).toBe("main");

    store.focusPane(workspaceKey, splitPaneId!);
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;

    expect(splitPaneId).toBe("pane_56565656-5656-5656-5656-565656565656");
    expect(layout.focusedPaneId).toBe(splitPaneId);
  });

  it("closeTab collapses an emptied pane and keeps the nearest sibling focused", () => {
    useWorkspaceLayoutIds("cccccccc-cccc-cccc-cccc-cccccccccccc");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    const secondTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.closeTab(workspaceKey, secondTabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(splitPaneId).toBe("pane_cccccccc-cccc-cccc-cccc-cccccccccccc");
    expect(layout.focusedPaneId).toBe("main");
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main"]);
  });

  it("splitPane enforces the maximum depth of four", () => {
    useWorkspaceLayoutIds(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
      "44444444-4444-4444-4444-444444444444",
      "55555555-5555-5555-5555-555555555555",
      "66666666-6666-6666-6666-666666666666",
      "77777777-7777-7777-7777-777777777777",
      "88888888-8888-8888-8888-888888888888",
    );

    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const a = store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    const b = store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/b.ts" });
    const c = store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/c.ts" });
    const d = store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/d.ts" });
    const e = store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/e.ts" });

    expect(a).toBeTruthy();
    const pane1 = store.splitPane(workspaceKey, {
      tabId: b!,
      targetPaneId: "main",
      position: "right",
    });
    const pane2 = store.splitPane(workspaceKey, {
      tabId: c!,
      targetPaneId: pane1!,
      position: "bottom",
    });
    const pane3 = store.splitPane(workspaceKey, {
      tabId: d!,
      targetPaneId: pane2!,
      position: "right",
    });
    const pane4 = store.splitPane(workspaceKey, {
      tabId: e!,
      targetPaneId: pane3!,
      position: "bottom",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(pane1).toBe("pane_11111111-1111-1111-1111-111111111111");
    expect(pane2).toBe("pane_33333333-3333-3333-3333-333333333333");
    expect(pane3).toBe("pane_55555555-5555-5555-5555-555555555555");
    expect(pane4).toBeNull();
    expect(getTreeDepth(layout.root)).toBe(4);
  });

  it("moveTabToPane collapses the source pane when its last tab moves out", () => {
    useWorkspaceLayoutIds("dddddddd-dddd-dddd-dddd-dddddddddddd");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const leftTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/a.ts",
    });
    const rightTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: rightTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.moveTabToPane(workspaceKey, leftTabId!, splitPaneId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(layout.focusedPaneId).toBe(splitPaneId);
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual([splitPaneId!]);
    expect(findPaneById(layout.root, splitPaneId)?.tabIds).toEqual([
      "file_/repo/worktree/b.ts",
      "file_/repo/worktree/a.ts",
    ]);
  });

  it("closeTab cascades group unwrapping when an inner split collapses to a single pane", () => {
    useWorkspaceLayoutIds(
      "78787878-7878-7878-7878-787878787878",
      "89898989-8989-8989-8989-898989898989",
      "9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a9a",
    );

    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    const secondTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const thirdTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/c.ts",
    });
    const paneBId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });
    const paneCId = store.splitPane(workspaceKey, {
      tabId: thirdTabId!,
      targetPaneId: paneBId!,
      position: "bottom",
    });

    store.closeTab(workspaceKey, secondTabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const rootGroup = expectGroup(layout.root);

    expect(paneBId).toBe("pane_78787878-7878-7878-7878-787878787878");
    expect(paneCId).toBe("pane_9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a9a");
    expect(layout.focusedPaneId).toBe(paneCId);
    expect(rootGroup.group.direction).toBe("horizontal");
    expect(rootGroup.group.children).toHaveLength(2);
    expect(
      rootGroup.group.children.map((child) => {
        expect(child.kind).toBe("pane");
        if (child.kind !== "pane") {
          throw new Error("Expected pane child");
        }
        return {
          id: child.pane.id,
          tabIds: child.pane.tabIds,
          focusedTabId: child.pane.focusedTabId,
        };
      }),
    ).toEqual([
      {
        id: "main",
        tabIds: ["file_/repo/worktree/a.ts"],
        focusedTabId: "file_/repo/worktree/a.ts",
      },
      {
        id: paneCId!,
        tabIds: ["file_/repo/worktree/c.ts"],
        focusedTabId: "file_/repo/worktree/c.ts",
      },
    ]);
    expect(rootGroup.group.sizes).toEqual([0.5, 0.5]);
  });

  it("openTab focuses the existing tab instead of creating a duplicate entry", () => {
    useWorkspaceLayoutIds("abababab-abab-abab-abab-abababababab");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    const secondTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.focusPane(workspaceKey, "main");
    const duplicateTabId = store.openTabFocused(workspaceKey, {
      kind: "file",
      path: "/repo/worktree/b.ts",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(splitPaneId).toBe("pane_abababab-abab-abab-abab-abababababab");
    expect(duplicateTabId).toBe(secondTabId);
    expect(layout.focusedPaneId).toBe(splitPaneId);
    expect(collectAllTabs(layout.root).map((tab) => tab.tabId)).toEqual([
      "file_/repo/worktree/a.ts",
      "file_/repo/worktree/b.ts",
    ]);
  });

  it("resizeSplit keeps sizes normalized while enforcing the minimum proportion", () => {
    useWorkspaceLayoutIds(
      "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "11111111-1111-1111-1111-111111111111",
    );

    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const a = store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    const b = store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/b.ts" });
    const c = store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/c.ts" });

    expect(a).toBeTruthy();
    const rightPaneId = store.splitPane(workspaceKey, {
      tabId: b!,
      targetPaneId: "main",
      position: "right",
    });
    const farRightPaneId = store.splitPane(workspaceKey, {
      tabId: c!,
      targetPaneId: rightPaneId!,
      position: "right",
    });

    const splitRoot = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root;
    const splitGroup = expectGroup(splitRoot);
    const nestedGroup = expectGroup(splitGroup.group.children[1]);
    store.resizeSplit(workspaceKey, nestedGroup.group.id, [0.01, 0.99]);

    const resizedRoot = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root;
    const resizedGroup = expectGroup(resizedRoot);
    const resizedNestedGroup = expectGroup(resizedGroup.group.children[1]);
    const total = resizedNestedGroup.group.sizes.reduce((sum, size) => sum + size, 0);

    expect(rightPaneId).toBe("pane_eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
    expect(farRightPaneId).toBe("pane_11111111-1111-1111-1111-111111111111");
    expect(resizedNestedGroup.group.sizes[0]).toBeGreaterThanOrEqual(0.1);
    expect(resizedNestedGroup.group.sizes[1]).toBeGreaterThanOrEqual(0.1);
    expect(total).toBeCloseTo(1, 10);
  });

  it("closing the last tab keeps a single empty pane in the layout", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const tabId = store.openTabFocused(workspaceKey, { kind: "draft", draftId: "draft-1" });
    store.closeTab(workspaceKey, tabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(layout).toEqual(createDefaultLayout());
  });

  it("keeps pinned archived agents in memory per workspace without persisting them", () => {
    const workspaceKey = createWorkspaceKey();
    const otherWorkspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: "ws-other-worktree",
    });

    expect(otherWorkspaceKey).toBeTruthy();

    const store = workspaceLayoutStore.getState();
    store.pinAgent(workspaceKey, "agent-1");
    store.pinAgent(workspaceKey, "agent-1");
    store.pinAgent(otherWorkspaceKey as string, "agent-2");

    let state = workspaceLayoutStore.getState();
    expect(Array.from(state.pinnedAgentIdsByWorkspace[workspaceKey] ?? [])).toEqual(["agent-1"]);
    expect(Array.from(state.pinnedAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    store.unpinAgent(workspaceKey, "agent-1");

    state = workspaceLayoutStore.getState();
    expect(state.pinnedAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(Array.from(state.pinnedAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    const partialize = workspaceLayoutStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");
    expect(partialize?.(state)).toEqual({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
    });
  });

  it("keeps hidden agent intents in memory per workspace without persisting them", () => {
    const workspaceKey = createWorkspaceKey();
    const otherWorkspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: "ws-other-worktree",
    });

    expect(otherWorkspaceKey).toBeTruthy();

    const store = workspaceLayoutStore.getState();
    store.hideAgent(workspaceKey, "agent-1");
    store.hideAgent(workspaceKey, "agent-1");
    store.hideAgent(otherWorkspaceKey as string, "agent-2");

    let state = workspaceLayoutStore.getState();
    expect(Array.from(state.hiddenAgentIdsByWorkspace[workspaceKey] ?? [])).toEqual(["agent-1"]);
    expect(Array.from(state.hiddenAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    store.unhideAgent(workspaceKey, "agent-1");

    state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(Array.from(state.hiddenAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    const partialize = workspaceLayoutStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");
    expect(partialize?.(state)).toEqual({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
    });
  });

  it("convertDraftToAgent removes the draft and focuses the existing canonical agent tab", () => {
    useWorkspaceLayoutIds("67676767-6767-6767-6767-676767676767");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: "draft-existing",
    });
    const agentTabId = store.openTabFocused(workspaceKey, { kind: "agent", agentId: "agent-1" });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: agentTabId!,
      targetPaneId: "main",
      position: "right",
    });

    const nextTabId = store.convertDraftToAgent(workspaceKey, draftTabId!, "agent-1");
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(splitPaneId).toBe("pane_67676767-6767-6767-6767-676767676767");
    expect(nextTabId).toBe("agent_agent-1");
    expect(collectAllTabs(layout.root).map((tab) => tab.tabId)).toEqual(["agent_agent-1"]);
    expect(layout.focusedPaneId).toBe(splitPaneId);
    expect(findPaneContainingTab(layout.root, "agent_agent-1")?.id).toBe(splitPaneId);
  });

  it("reconcileTabs canonicalizes duplicates and prunes stale entity tabs from hydrated snapshots", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: {
          root: {
            kind: "pane",
            pane: {
              id: "main",
              tabIds: ["draft_agent", "agent_agent-1", "terminal_orphan", "draft-1"],
              focusedTabId: "draft_agent",
              tabs: [
                {
                  tabId: "draft_agent",
                  target: { kind: "agent", agentId: "agent-1" },
                  createdAt: 1,
                },
                {
                  tabId: "agent_agent-1",
                  target: { kind: "agent", agentId: "agent-1" },
                  createdAt: 2,
                },
                {
                  tabId: "terminal_orphan",
                  target: { kind: "terminal", terminalId: "term-stale" },
                  createdAt: 3,
                },
                {
                  tabId: "draft-1",
                  target: { kind: "draft", draftId: "draft-1" },
                  createdAt: 4,
                },
              ],
            } as SplitPane,
          },
          focusedPaneId: "main",
        },
      },
      pinnedAgentIdsByWorkspace: {
        [workspaceKey]: new Set<string>(["agent-2"]),
      },
    }));

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      knownAgentIds: ["agent-1", "agent-2"],
      standaloneTerminalIds: ["term-1"],
      hasActivePendingDraftCreate: false,
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const tabs = collectAllTabs(layout.root);

    expect(tabs.map((tab) => tab.tabId)).toEqual([
      "agent_agent-1",
      "draft-1",
      "agent_agent-2",
      "terminal_term-1",
    ]);
    expect(tabs.find((tab) => tab.tabId === "agent_agent-1")).toEqual({
      tabId: "agent_agent-1",
      target: { kind: "agent", agentId: "agent-1" },
      createdAt: 2,
    });
    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe("agent_agent-1");
  });

  it("reconcileTabs does not re-add locally hidden agent tabs", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.setState((state) => ({
      ...state,
      hiddenAgentIdsByWorkspace: {
        [workspaceKey]: new Set<string>(["agent-1"]),
      },
    }));

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      knownAgentIds: ["agent-1"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).toEqual([]);
  });

  it("reconcileTabs does not auto-open subagents omitted from autoOpenAgentIds", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["parent-agent", "child-agent"],
      autoOpenAgentIds: ["parent-agent"],
      knownAgentIds: ["parent-agent", "child-agent"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(
      workspaceLayoutStore
        .getState()
        .getWorkspaceTabs(workspaceKey)
        .map((tab) => tab.tabId),
    ).toEqual(["agent_parent-agent"]);
  });

  it("reconcileTabs keeps manually opened subagent tabs that remain active", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "child-agent" });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["parent-agent", "child-agent"],
      autoOpenAgentIds: ["parent-agent"],
      knownAgentIds: ["parent-agent", "child-agent"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(
      workspaceLayoutStore
        .getState()
        .getWorkspaceTabs(workspaceKey)
        .map((tab) => tab.tabId),
    ).toEqual(["agent_child-agent", "agent_parent-agent"]);
  });

  it("reconcileTabs prunes archived subagent tabs that are no longer active", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "child-agent" });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["parent-agent"],
      autoOpenAgentIds: ["parent-agent"],
      knownAgentIds: ["parent-agent", "child-agent"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(
      workspaceLayoutStore
        .getState()
        .getWorkspaceTabs(workspaceKey)
        .map((tab) => tab.tabId),
    ).toEqual(["agent_parent-agent"]);
  });

  it("openTabFocused reopens hidden subagent tabs and clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "child-agent");
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["child-agent"],
      autoOpenAgentIds: [],
      knownAgentIds: ["child-agent"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).toEqual([]);

    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "child-agent" });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(state.getWorkspaceTabs(workspaceKey).map((tab) => tab.tabId)).toEqual([
      "agent_child-agent",
    ]);
  });

  it("reconcileTabs auto-opens only standalone terminals while keeping explicitly opened live terminals", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const scriptTabId = store.openTabFocused(workspaceKey, {
      kind: "terminal",
      terminalId: "term-script",
    });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      knownTerminalIds: ["term-script", "term-manual"],
      standaloneTerminalIds: ["term-manual"],
      hasActivePendingDraftCreate: false,
    });

    const tabs = workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(tabs.map((tab) => tab.tabId)).toEqual(["terminal_term-script", "terminal_term-manual"]);
    expect(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId).toBe(scriptTabId);
  });

  it("reconcileTabs does not auto-open live non-standalone terminals", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      knownTerminalIds: ["term-script"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).toEqual([]);
  });

  it("explicitly opening an agent tab clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    store.openTabFocused(workspaceKey, { kind: "agent", agentId: "agent-1" });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(state.getWorkspaceTabs(workspaceKey).map((tab) => tab.tabId)).toEqual(["agent_agent-1"]);
  });

  it("pinning an agent clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    expect(workspaceLayoutStore.getState().hiddenAgentIdsByWorkspace[workspaceKey]).toBeDefined();

    store.pinAgent(workspaceKey, "agent-1");

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(Array.from(state.pinnedAgentIdsByWorkspace[workspaceKey] ?? [])).toEqual(["agent-1"]);
  });

  it("retargeting a tab to an agent clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    const tabId = store.openTabFocused(workspaceKey, { kind: "file", path: "/repo/worktree/a.ts" });
    store.retargetTab(workspaceKey, tabId!, { kind: "agent", agentId: "agent-1" });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
  });
});
