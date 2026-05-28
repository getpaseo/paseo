import { describe, expect, it } from "vitest";
import {
  applyCloseTab,
  applyEnsureTab,
  applyFocusTab,
  applyOpenDraftTab,
  applyOpenOrFocusTab,
  applyRetargetTab,
  buildWorkspaceTabPersistenceKey,
  initialWorkspaceTabsCoreState,
  type WorkspaceTabsCoreState,
} from "./state";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "/repo/worktree";
const WORKSPACE_KEY = `${SERVER_ID}:${WORKSPACE_ID}`;

const NOW = 1_700_000_000_000;

function emptyState(): WorkspaceTabsCoreState {
  return {
    uiTabsByWorkspace: {},
    tabOrderByWorkspace: {},
    focusedTabIdByWorkspace: {},
  };
}

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

describe("workspace-tabs-store reducers", () => {
  it("keeps a promoted draft tab in-place by mutating target without changing tab id", () => {
    const draftTabId = "draft_123";

    let state = emptyState();
    state = applyEnsureTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: "left" },
      now: NOW,
    }).state;
    state = applyOpenDraftTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      draftId: draftTabId,
      now: NOW,
    }).state;
    state = applyEnsureTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: "right" },
      now: NOW,
    }).state;
    state = applyFocusTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabId: draftTabId,
    });

    const beforeOrder = state.tabOrderByWorkspace[WORKSPACE_KEY] ?? [];

    const retargeted = applyRetargetTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabId: draftTabId,
      target: { kind: "agent", agentId: "created" },
    });

    const afterOrder = retargeted.state.tabOrderByWorkspace[WORKSPACE_KEY] ?? [];
    const tabs = retargeted.state.uiTabsByWorkspace[WORKSPACE_KEY] ?? [];
    const retargetedTab = tabs.find((tab) => tab.tabId === draftTabId) ?? null;

    expect(retargeted.tabId).toBe(draftTabId);
    expect(afterOrder).toEqual(beforeOrder);
    expect(retargeted.state.focusedTabIdByWorkspace[WORKSPACE_KEY]).toBe(draftTabId);
    expect(retargetedTab?.target).toEqual({ kind: "agent", agentId: "created" });
  });

  it("ensureTab adds non-focused membership while openOrFocusTab focuses", () => {
    let state = emptyState();
    const ensured = applyEnsureTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "terminal", terminalId: "term-1" },
      now: NOW,
    });
    state = ensured.state;
    expect(ensured.tabId).toBe("terminal_term-1");
    expect(state.focusedTabIdByWorkspace[WORKSPACE_KEY]).toBeUndefined();

    const focused = applyOpenOrFocusTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "terminal", terminalId: "term-1" },
      now: NOW,
    });
    expect(focused.tabId).toBe("terminal_term-1");
    expect(focused.state.focusedTabIdByWorkspace[WORKSPACE_KEY]).toBe("terminal_term-1");
  });

  it("ensureTab deduplicates by target when a retargeted tab already exists", () => {
    const draftTabId = "draft_x";

    let state = emptyState();
    state = applyOpenDraftTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      draftId: draftTabId,
      now: NOW,
    }).state;
    state = applyRetargetTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabId: draftTabId,
      target: { kind: "agent", agentId: "created-agent" },
    }).state;

    const ensured = applyEnsureTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: "created-agent" },
      now: NOW,
    });

    const tabs = ensured.state.uiTabsByWorkspace[WORKSPACE_KEY] ?? [];
    const order = ensured.state.tabOrderByWorkspace[WORKSPACE_KEY] ?? [];
    const matchingTabs = tabs.filter(
      (tab) => tab.target.kind === "agent" && tab.target.agentId === "created-agent",
    );

    expect(ensured.tabId).toBe(draftTabId);
    expect(matchingTabs).toHaveLength(1);
    expect(order).toEqual([draftTabId]);
  });

  it("openDraftTab creates a draft tab and deduplicates by draftId", () => {
    let state = emptyState();
    const first = applyOpenDraftTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      draftId: "draft-1",
      now: NOW,
    });
    state = first.state;
    const second = applyOpenDraftTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      draftId: "draft-2",
      now: NOW,
    });
    state = second.state;

    expect(first.tabId).toBe("draft-1");
    expect(second.tabId).toBe("draft-2");
    expect(state.tabOrderByWorkspace[WORKSPACE_KEY]).toEqual([first.tabId, second.tabId]);
    expect(state.uiTabsByWorkspace[WORKSPACE_KEY]).toEqual([
      {
        tabId: "draft-1",
        target: { kind: "draft", draftId: "draft-1" },
        createdAt: NOW,
      },
      {
        tabId: "draft-2",
        target: { kind: "draft", draftId: "draft-2" },
        createdAt: NOW,
      },
    ]);
  });

  it("keeps draft setup on a retargeted tab", () => {
    let state = emptyState();
    const ensured = applyEnsureTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: "agent-1" },
      now: NOW,
    });
    expect(ensured.tabId).toBe("agent_agent-1");
    state = ensured.state;

    const retargeted = applyRetargetTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabId: ensured.tabId!,
      target: {
        kind: "draft",
        draftId: "draft-replacement",
        setup: {
          provider: "mock",
          cwd: "/repo/worktree",
          modeId: "load-test",
          model: "ten-second-stream",
          thinkingOptionId: null,
          featureValues: { effort: "high" },
        },
      },
    });

    expect(retargeted.state.uiTabsByWorkspace[WORKSPACE_KEY]?.[0]?.target).toEqual({
      kind: "draft",
      draftId: "draft-replacement",
      setup: {
        provider: "mock",
        cwd: "/repo/worktree",
        modeId: "load-test",
        model: "ten-second-stream",
        thinkingOptionId: null,
        featureValues: { effort: "high" },
      },
    });
  });

  it("updates an existing draft tab when the setup changes", () => {
    let state = emptyState();
    const first = applyEnsureTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "draft", draftId: "draft-1" },
      now: NOW,
    });
    state = first.state;
    const second = applyEnsureTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: {
        kind: "draft",
        draftId: "draft-1",
        setup: {
          provider: "mock",
          cwd: "/repo/worktree",
          modeId: "load-test",
          model: "ten-second-stream",
          thinkingOptionId: null,
          featureValues: {},
        },
      },
      now: NOW,
    });
    state = second.state;

    expect(second.tabId).toBe(first.tabId);
    expect(state.uiTabsByWorkspace[WORKSPACE_KEY]).toHaveLength(1);
    expect(state.uiTabsByWorkspace[WORKSPACE_KEY]?.[0]?.target).toEqual({
      kind: "draft",
      draftId: "draft-1",
      setup: {
        provider: "mock",
        cwd: "/repo/worktree",
        modeId: "load-test",
        model: "ten-second-stream",
        thinkingOptionId: null,
        featureValues: {},
      },
    });
  });

  it("retargeting a background draft keeps the currently focused tab focused", () => {
    const draftTabId = "draft_background";

    let state = emptyState();
    state = applyOpenDraftTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      draftId: draftTabId,
      now: NOW,
    }).state;
    const file = applyOpenOrFocusTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "file", path: "/repo/worktree/src/index.ts" },
      now: NOW,
    });
    state = file.state;

    state = applyRetargetTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabId: draftTabId,
      target: { kind: "agent", agentId: "created-agent" },
    }).state;

    expect(state.focusedTabIdByWorkspace[WORKSPACE_KEY]).toBe(file.tabId);
  });

  it("openOrFocusTab re-focuses an existing file tab after the workspace focus changed", () => {
    let state = emptyState();
    const fileResult = applyOpenOrFocusTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "file", path: "/repo/worktree/src/index.ts" },
      now: NOW,
    });
    state = fileResult.state;
    const terminalResult = applyOpenOrFocusTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "terminal", terminalId: "term-1" },
      now: NOW,
    });
    state = terminalResult.state;

    expect(fileResult.tabId).toBe("file_/repo/worktree/src/index.ts");
    expect(terminalResult.tabId).toBe("terminal_term-1");
    expect(state.focusedTabIdByWorkspace[WORKSPACE_KEY]).toBe(terminalResult.tabId);

    const reopened = applyOpenOrFocusTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "file", path: "/repo/worktree/src/index.ts" },
      now: NOW,
    });

    expect(reopened.tabId).toBe(fileResult.tabId);
    expect(reopened.state.focusedTabIdByWorkspace[WORKSPACE_KEY]).toBe(fileResult.tabId);
  });

  it("builds a deterministic setup tab keyed by workspace id", () => {
    const result = applyOpenOrFocusTab(initialWorkspaceTabsCoreState, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "setup", workspaceId: WORKSPACE_ID },
      now: NOW,
    });

    expect(result.tabId).toBe(`setup_${WORKSPACE_ID}`);
    expect(result.state.focusedTabIdByWorkspace[WORKSPACE_KEY]).toBe(result.tabId);
  });

  it("closeTab focuses the most-recent remaining tab when the focused tab is removed", () => {
    let state = emptyState();
    const first = applyOpenOrFocusTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: "left" },
      now: NOW,
    });
    state = first.state;
    const second = applyOpenOrFocusTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: "right" },
      now: NOW,
    });
    state = second.state;
    expect(state.focusedTabIdByWorkspace[WORKSPACE_KEY]).toBe(second.tabId);

    state = applyCloseTab(state, {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabId: second.tabId!,
    });

    expect(state.focusedTabIdByWorkspace[WORKSPACE_KEY]).toBe(first.tabId);
    expect(state.uiTabsByWorkspace[WORKSPACE_KEY]).toHaveLength(1);
  });
});
