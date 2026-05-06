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

import {
  buildWorkspaceTabPersistenceKey,
  useWorkspaceTabsStore,
} from "@/stores/workspace-tabs-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "/repo/worktree";

describe("buildWorkspaceTabPersistenceKey", () => {
  it("preserves opaque workspace ids instead of normalizing them like paths", () => {
    expect(
      buildWorkspaceTabPersistenceKey({
        serverId: SERVER_ID,
        workspaceId: "  setup\\workspace\\  ",
      }),
    ).toBe("server-1:setup\\workspace\\");
  });
});

describe("workspace-tabs-store retargetTab", () => {
  beforeEach(() => {
    useWorkspaceTabsStore.setState({
      uiTabsByWorkspace: {},
      tabOrderByWorkspace: {},
      focusedTabIdByWorkspace: {},
    });
  });

  it("keeps a promoted draft tab in-place by mutating target without changing tab id", () => {
    const draftTabId = "draft_123";
    const key = buildWorkspaceTabPersistenceKey({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID });
    expect(key).toBeTruthy();
    const workspaceKey = key as string;

    useWorkspaceTabsStore.getState().ensureTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: "left" },
    });
    useWorkspaceTabsStore.getState().openDraftTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      draftId: draftTabId,
    });
    useWorkspaceTabsStore.getState().ensureTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: "right" },
    });
    useWorkspaceTabsStore.getState().focusTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabId: draftTabId,
    });

    const before = useWorkspaceTabsStore.getState();
    const beforeOrder = before.tabOrderByWorkspace[workspaceKey] ?? [];

    const retargeted = useWorkspaceTabsStore.getState().retargetTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabId: draftTabId,
      target: { kind: "agent", agentId: "created" },
    });

    const after = useWorkspaceTabsStore.getState();
    const afterOrder = after.tabOrderByWorkspace[workspaceKey] ?? [];
    const tabs = after.uiTabsByWorkspace[workspaceKey] ?? [];
    const retargetedTab = tabs.find((tab) => tab.tabId === draftTabId) ?? null;

    expect(retargeted).toBe(draftTabId);
    expect(afterOrder).toEqual(beforeOrder);
    expect(after.focusedTabIdByWorkspace[workspaceKey]).toBe(draftTabId);
    expect(retargetedTab?.target).toEqual({ kind: "agent", agentId: "created" });
  });

  it("ensureTab adds non-focused membership while openOrFocusTab focuses", () => {
    const key = buildWorkspaceTabPersistenceKey({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID });
    expect(key).toBeTruthy();
    const workspaceKey = key as string;

    const terminalTabId = useWorkspaceTabsStore.getState().ensureTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "terminal", terminalId: "term-1" },
    });
    expect(terminalTabId).toBe("terminal_term-1");
    expect(useWorkspaceTabsStore.getState().focusedTabIdByWorkspace[workspaceKey]).toBeUndefined();

    const focusedTabId = useWorkspaceTabsStore.getState().openOrFocusTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "terminal", terminalId: "term-1" },
    });
    expect(focusedTabId).toBe("terminal_term-1");
    expect(useWorkspaceTabsStore.getState().focusedTabIdByWorkspace[workspaceKey]).toBe(
      "terminal_term-1",
    );
  });

  it("ensureTab deduplicates by target when a retargeted tab already exists", () => {
    const draftTabId = "draft_x";
    const key = buildWorkspaceTabPersistenceKey({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID });
    expect(key).toBeTruthy();
    const workspaceKey = key as string;

    useWorkspaceTabsStore.getState().openDraftTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      draftId: draftTabId,
    });
    useWorkspaceTabsStore.getState().retargetTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabId: draftTabId,
      target: { kind: "agent", agentId: "created-agent" },
    });

    const ensured = useWorkspaceTabsStore.getState().ensureTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: "created-agent" },
    });

    const state = useWorkspaceTabsStore.getState();
    const tabs = state.uiTabsByWorkspace[workspaceKey] ?? [];
    const order = state.tabOrderByWorkspace[workspaceKey] ?? [];
    const matchingTabs = tabs.filter(
      (tab) => tab.target.kind === "agent" && tab.target.agentId === "created-agent",
    );

    expect(ensured).toBe(draftTabId);
    expect(matchingTabs).toHaveLength(1);
    expect(order).toEqual([draftTabId]);
  });

  it("openDraftTab creates a draft tab and deduplicates by draftId", () => {
    const key = buildWorkspaceTabPersistenceKey({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID });
    expect(key).toBeTruthy();
    const workspaceKey = key as string;

    const firstTabId = useWorkspaceTabsStore.getState().openDraftTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      draftId: "draft-1",
    });
    const secondTabId = useWorkspaceTabsStore.getState().openDraftTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      draftId: "draft-2",
    });

    const state = useWorkspaceTabsStore.getState();
    expect(firstTabId).toBe("draft-1");
    expect(secondTabId).toBe("draft-2");
    expect(state.tabOrderByWorkspace[workspaceKey]).toEqual([firstTabId, secondTabId]);
    expect(state.uiTabsByWorkspace[workspaceKey]).toEqual([
      {
        tabId: "draft-1",
        target: { kind: "draft", draftId: "draft-1" },
        createdAt: expect.any(Number),
      },
      {
        tabId: "draft-2",
        target: { kind: "draft", draftId: "draft-2" },
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("retargeting a background draft keeps the currently focused tab focused", () => {
    const draftTabId = "draft_background";
    const key = buildWorkspaceTabPersistenceKey({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID });
    expect(key).toBeTruthy();
    const workspaceKey = key as string;

    useWorkspaceTabsStore.getState().openDraftTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      draftId: draftTabId,
    });
    const focusedFileTabId = useWorkspaceTabsStore.getState().openOrFocusTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "file", path: "/repo/worktree/src/index.ts" },
    });

    useWorkspaceTabsStore.getState().retargetTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabId: draftTabId,
      target: { kind: "agent", agentId: "created-agent" },
    });

    expect(useWorkspaceTabsStore.getState().focusedTabIdByWorkspace[workspaceKey]).toBe(
      focusedFileTabId,
    );
  });

  it("openOrFocusTab re-focuses an existing file tab after the workspace focus changed", () => {
    const key = buildWorkspaceTabPersistenceKey({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID });
    expect(key).toBeTruthy();
    const workspaceKey = key as string;

    const fileTabId = useWorkspaceTabsStore.getState().openOrFocusTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "file", path: "/repo/worktree/src/index.ts" },
    });
    const terminalTabId = useWorkspaceTabsStore.getState().openOrFocusTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "terminal", terminalId: "term-1" },
    });

    expect(fileTabId).toBe("file_/repo/worktree/src/index.ts");
    expect(terminalTabId).toBe("terminal_term-1");
    expect(useWorkspaceTabsStore.getState().focusedTabIdByWorkspace[workspaceKey]).toBe(
      terminalTabId,
    );

    const reopenedFileTabId = useWorkspaceTabsStore.getState().openOrFocusTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "file", path: "/repo/worktree/src/index.ts" },
    });

    expect(reopenedFileTabId).toBe(fileTabId);
    expect(useWorkspaceTabsStore.getState().focusedTabIdByWorkspace[workspaceKey]).toBe(fileTabId);
  });

  it("builds a deterministic setup tab keyed by workspace id", () => {
    const key = buildWorkspaceTabPersistenceKey({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID });
    expect(key).toBeTruthy();
    const workspaceKey = key as string;

    const tabId = useWorkspaceTabsStore.getState().openOrFocusTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "setup", workspaceId: WORKSPACE_ID },
    });

    expect(tabId).toBe(`setup_${WORKSPACE_ID}`);
    expect(useWorkspaceTabsStore.getState().focusedTabIdByWorkspace[workspaceKey]).toBe(tabId);
  });
});
