import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateStorage } from "zustand/middleware";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { collectAllTabs, createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  moveAgentTabToWorkspace,
  setWorkspaceTabSyncClientResolver,
  startWorkspaceTabSync,
} from "@/screens/workspace/workspace-tab-sync";
import {
  TAB_CLOSED_LABEL,
  TAB_ORDER_LABEL,
  TAB_WORKSPACE_LABEL,
} from "@/screens/workspace/workspace-tab-move";

const SERVER = "srv-a";

function createMemoryStorage(): StateStorage {
  const values = new Map<string, string>();
  return {
    getItem: async (name) => values.get(name) ?? null,
    setItem: async (name, value) => {
      values.set(name, value);
    },
    removeItem: async (name) => {
      values.delete(name);
    },
  };
}

const layoutStore = createWorkspaceLayoutStore(undefined, createMemoryStorage());

function makeAgent(id: string, labels: Record<string, string> = {}): Agent {
  return {
    serverId: SERVER,
    id,
    provider: "codex",
    status: "running",
    createdAt: new Date("2026-04-01T03:00:00.000Z"),
    updatedAt: new Date("2026-04-01T03:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-04-01T03:00:00.000Z"),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: id,
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels,
    archivedAt: null,
    turn: { phase: "idle", cancellationRequestId: null },
  };
}

function workspaceKey(workspaceId: string): string {
  return `${SERVER}:${workspaceId}`;
}

function tabsIn(workspaceId: string) {
  const layout = layoutStore.getState().layoutByWorkspace[workspaceKey(workspaceId)];
  return layout ? collectAllTabs(layout.root) : [];
}

function agentTabIdsIn(workspaceId: string): string[] {
  return tabsIn(workspaceId).flatMap((tab) =>
    tab.target.kind === "agent" ? [tab.target.agentId] : [],
  );
}

function replaceAgent(agent: Agent): void {
  const agents = useSessionStore.getState().sessions[SERVER]?.agents ?? new Map<string, Agent>();
  const next = new Map(agents);
  next.set(agent.id, agent);
  useSessionStore.getState().setAgents(SERVER, next);
}

function setAgentLabels(agentId: string, labels: Record<string, string>): void {
  const agents = useSessionStore.getState().sessions[SERVER]?.agents;
  if (!agents?.has(agentId)) {
    throw new Error(`agent ${agentId} not seeded`);
  }
  const next = new Map(agents);
  next.set(agentId, { ...agents.get(agentId)!, labels });
  useSessionStore.getState().setAgents(SERVER, next);
}

describe("workspace tab sync", () => {
  const updateAgent = vi.fn();
  let echoWrites = true;

  beforeEach(() => {
    vi.useFakeTimers();
    updateAgent.mockClear();
    // Realistic round-trip: every label write lands back on the agent the way
    // the daemon echo does. Tests that need an in-flight write flip the flag.
    echoWrites = true;
    setWorkspaceTabSyncClientResolver((serverId) =>
      serverId === SERVER
        ? {
            updateAgent: (agentId: string, updates: { labels: Record<string, string> }) => {
              updateAgent(agentId, updates);
              if (echoWrites) {
                setAgentLabels(agentId, updates.labels);
              }
            },
          }
        : null,
    );
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
    layoutStore.setState({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
      explorerSidebarWidthByWorkspace: {},
      pinnedAgentIdsByWorkspace: {},
      hiddenAgentIdsByWorkspace: {},
      focusRestorationByWorkspace: {},
      explorerSidebarPaneIdByWorkspace: {},
      sidePaneIdByWorkspace: {},
    });
    useSessionStore.getState().initializeSession(SERVER, {} as DaemonClient);
    useSessionStore.getState().setAgents(SERVER, new Map([["agent-1", makeAgent("agent-1")]]));
    startWorkspaceTabSync({ layoutStore });
  });

  afterEach(() => {
    vi.useRealTimers();
    setWorkspaceTabSyncClientResolver(null);
  });

  it("writes the placement label the moment a user opens an agent tab", () => {
    layoutStore.getState().openTab({
      workspaceKey: workspaceKey("ws-a"),
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    expect(updateAgent).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        labels: expect.objectContaining({
          [TAB_WORKSPACE_LABEL]: "ws-a",
          [TAB_CLOSED_LABEL]: "",
        }),
      }),
    );
  });

  it("writes the closed tombstone when a user closes an agent tab", () => {
    const tabId = layoutStore.getState().openTab({
      workspaceKey: workspaceKey("ws-a"),
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    updateAgent.mockClear();
    layoutStore.getState().closeTab(workspaceKey("ws-a"), tabId!);
    expect(updateAgent).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        labels: expect.objectContaining({ [TAB_CLOSED_LABEL]: "1" }),
      }),
    );
  });

  it("moves the tab when a remote workspace label lands", () => {
    layoutStore.getState().openTab({
      workspaceKey: workspaceKey("ws-a"),
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    // The echo of another client's move: agent_state carries the target label.
    setAgentLabels("agent-1", {
      [TAB_WORKSPACE_LABEL]: "ws-b",
      [TAB_CLOSED_LABEL]: "",
      [TAB_ORDER_LABEL]: "000000",
    });
    expect(agentTabIdsIn("ws-b")).toEqual(["agent-1"]);
    expect(agentTabIdsIn("ws-a")).toEqual([]);
  });

  it("closes the tab everywhere when a remote tombstone lands", () => {
    layoutStore.getState().openTab({
      workspaceKey: workspaceKey("ws-a"),
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    setAgentLabels("agent-1", {
      [TAB_WORKSPACE_LABEL]: "ws-a",
      [TAB_CLOSED_LABEL]: "1",
    });
    expect(agentTabIdsIn("ws-a")).toEqual([]);
  });

  it("keeps a moved tab in the target while its order write is in flight", () => {
    layoutStore.getState().openTab({
      workspaceKey: workspaceKey("ws-a"),
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    // Stored labels still say ws-a (the move echo has not landed yet), and the
    // stale order differs from the moved tab's new rank so the debounced
    // publish actually writes a fresh order mid-flight.
    setAgentLabels("agent-1", {
      [TAB_WORKSPACE_LABEL]: "ws-a",
      [TAB_CLOSED_LABEL]: "",
      [TAB_ORDER_LABEL]: "000005",
    });
    echoWrites = false;
    moveAgentTabToWorkspace({
      serverId: SERVER,
      sourceWorkspaceKey: workspaceKey("ws-a"),
      targetWorkspaceKey: workspaceKey("ws-b"),
      targetWorkspaceId: "ws-b",
      agentId: "agent-1",
      tabId: tabsIn("ws-a")[0]!.tabId,
    });
    expect(agentTabIdsIn("ws-b")).toEqual(["agent-1"]);
    // A user-side layout change (unrelated to the engine's own mutation, which
    // is internalSync-gated) schedules the debounced publish while the move
    // write is still in flight: it must extend the pending record, not drop
    // the workspace intent. Then a concurrent remote order write (still
    // carrying the stale ws-a) lands and kicks a reconcile — without the
    // merged pending record this snaps the tab back to ws-a.
    layoutStore.setState({} as never);
    vi.advanceTimersByTime(200);
    setAgentLabels("agent-1", {
      [TAB_WORKSPACE_LABEL]: "ws-a",
      [TAB_CLOSED_LABEL]: "",
      [TAB_ORDER_LABEL]: "000006",
    });
    expect(agentTabIdsIn("ws-b")).toEqual(["agent-1"]);
    expect(agentTabIdsIn("ws-a")).toEqual([]);
  });

  it("refuses to move a tab whose close tombstone landed first", () => {
    const tabId = layoutStore.getState().openTab({
      workspaceKey: workspaceKey("ws-a"),
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    // Another client closed the tab while the move gesture was still open.
    setAgentLabels("agent-1", {
      [TAB_WORKSPACE_LABEL]: "ws-a",
      [TAB_CLOSED_LABEL]: "1",
    });
    // Let the open intent's pending TTL lapse so the stored tombstone governs.
    vi.advanceTimersByTime(16_000);
    const moved = moveAgentTabToWorkspace({
      serverId: SERVER,
      sourceWorkspaceKey: workspaceKey("ws-a"),
      targetWorkspaceKey: workspaceKey("ws-b"),
      targetWorkspaceId: "ws-b",
      agentId: "agent-1",
      tabId: tabId!,
    });
    expect(moved).toBe(false);
    expect(agentTabIdsIn("ws-b")).toEqual([]);
  });

  it("still moves a tab that was just reopened while the echo is in flight", () => {
    // The stored tombstone is older than the local reopen: the reopen's
    // `closed: false` write has not echoed back yet.
    setAgentLabels("agent-1", {
      [TAB_WORKSPACE_LABEL]: "ws-a",
      [TAB_CLOSED_LABEL]: "1",
    });
    echoWrites = false;
    const tabId = layoutStore.getState().openTab({
      workspaceKey: workspaceKey("ws-a"),
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    const moved = moveAgentTabToWorkspace({
      serverId: SERVER,
      sourceWorkspaceKey: workspaceKey("ws-a"),
      targetWorkspaceKey: workspaceKey("ws-b"),
      targetWorkspaceId: "ws-b",
      agentId: "agent-1",
      tabId: tabId!,
    });
    expect(moved).toBe(true);
    expect(agentTabIdsIn("ws-b")).toEqual(["agent-1"]);
  });

  it("keeps a history-opened archived agent tab open", () => {
    replaceAgent({
      ...makeAgent("agent-1"),
      archivedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    layoutStore.getState().openTab({
      workspaceKey: workspaceKey("ws-a"),
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    expect(agentTabIdsIn("ws-a")).toEqual(["agent-1"]);
    const hidden = layoutStore.getState().hiddenAgentIdsByWorkspace[workspaceKey("ws-a")];
    expect(hidden?.has("agent-1") ?? false).toBe(false);
  });

  it("does not reopen an archived agent tab the user did not keep open", () => {
    layoutStore.getState().openTab({
      workspaceKey: workspaceKey("ws-a"),
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    layoutStore.getState().unpinAgent(workspaceKey("ws-a"), "agent-1");
    vi.advanceTimersByTime(16_000);
    replaceAgent({
      ...makeAgent("agent-1", {
        [TAB_WORKSPACE_LABEL]: "ws-a",
        [TAB_CLOSED_LABEL]: "",
      }),
      archivedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    expect(agentTabIdsIn("ws-a")).toEqual([]);
  });

  it("closes a moved tab when the agent is archived", () => {
    layoutStore.getState().openTab({
      workspaceKey: workspaceKey("ws-a"),
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    setAgentLabels("agent-1", {
      [TAB_WORKSPACE_LABEL]: "ws-b",
      [TAB_CLOSED_LABEL]: "",
    });
    expect(agentTabIdsIn("ws-b")).toEqual(["agent-1"]);
    replaceAgent({
      ...makeAgent("agent-1", {
        [TAB_WORKSPACE_LABEL]: "ws-b",
        [TAB_CLOSED_LABEL]: "",
      }),
      archivedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    expect(agentTabIdsIn("ws-b")).toEqual([]);
    expect(agentTabIdsIn("ws-a")).toEqual([]);
  });

  it("does not clear another client's close when unarchive arrives", () => {
    replaceAgent({
      ...makeAgent("agent-1"),
      archivedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    layoutStore.getState().openTab({
      workspaceKey: workspaceKey("ws-a"),
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    expect(agentTabIdsIn("ws-a")).toEqual(["agent-1"]);
    updateAgent.mockClear();
    replaceAgent({
      ...makeAgent("agent-1", {
        [TAB_WORKSPACE_LABEL]: "ws-a",
        [TAB_CLOSED_LABEL]: "1",
      }),
      archivedAt: null,
    });
    expect(agentTabIdsIn("ws-a")).toEqual([]);
    expect(updateAgent).not.toHaveBeenCalled();
  });
});
