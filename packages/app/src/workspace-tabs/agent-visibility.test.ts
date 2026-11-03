import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  buildWorkspaceTabSnapshot,
  createWorkspaceAgentVisibilitySelector,
  deriveWorkspaceAgentVisibility,
  shouldPruneWorkspaceAgentTab,
  workspaceAgentVisibilityEqual,
} from "@/workspace-tabs/agent-visibility";

function makeAgent(input: {
  id: string;
  cwd: string;
  workspaceId?: string;
  parentAgentId?: string | null;
  archivedAt?: Date | null;
  createdAt?: Date;
  lastActivityAt?: Date;
}): Agent {
  const createdAt = input.createdAt ?? new Date("2026-03-04T00:00:00.000Z");
  const lastActivityAt = input.lastActivityAt ?? createdAt;
  return {
    serverId: "srv",
    id: input.id,
    provider: "codex",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt,
    updatedAt: createdAt,
    lastUserMessageAt: null,
    lastActivityAt,
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
    runtimeInfo: {
      provider: "codex",
      sessionId: null,
    },
    title: null,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    model: null,
    thinkingOptionId: null,
    parentAgentId: input.parentAgentId ?? null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: input.archivedAt ?? null,
  };
}

const WORKSPACE_ID = "ws-1";

describe("workspace agent visibility", () => {
  it("removes a restored pinned tab from an unrelated workspace once its owner is known", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: async (key: string) => {
        values.delete(key);
      },
    };
    const original = createWorkspaceLayoutStore(undefined, storage);
    await original.persist.rehydrate();
    const agent = makeAgent({ id: "restored-agent", cwd: "/project-a", workspaceId: "ws-a" });
    for (const workspaceId of ["ws-a", "ws-b"]) {
      original.getState().openTab({
        workspaceKey: `srv:${workspaceId}`,
        target: { kind: "agent", agentId: agent.id },
        intent: "reveal",
        pin: true,
      });
    }
    const restored = createWorkspaceLayoutStore(undefined, storage);
    await restored.persist.rehydrate();
    const sessionAgents = new Map([[agent.id, agent]]);
    const beforeHydration = buildWorkspaceTabSnapshot({
      agentVisibility: deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: "ws-b" }),
      agentsHydrated: false,
      terminalsHydrated: true,
      knownTerminalIds: [],
      standaloneTerminalIds: [],
      hasActivePendingTerminalCreate: false,
      hasActivePendingDraftCreate: false,
    });
    restored.getState().reconcileTabs("srv:ws-b", beforeHydration);
    expect(restored.getState().pinnedAgentIdsByWorkspace["srv:ws-b"]).toEqual(new Set([agent.id]));
    for (const workspaceId of ["ws-a", "ws-b"]) {
      restored.getState().reconcileTabs(
        `srv:${workspaceId}`,
        buildWorkspaceTabSnapshot({
          agentVisibility: deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId }),
          agentsHydrated: true,
          terminalsHydrated: true,
          knownTerminalIds: [],
          standaloneTerminalIds: [],
          hasActivePendingTerminalCreate: false,
          hasActivePendingDraftCreate: false,
        }),
      );
    }

    expect(
      restored
        .getState()
        .getWorkspaceTabs("srv:ws-a")
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.target),
    ).toEqual([{ kind: "agent", agentId: agent.id }]);
    expect(
      restored
        .getState()
        .getWorkspaceTabs("srv:ws-b")
        .filter((tab) => tab.target.kind === "agent"),
    ).toEqual([]);
    expect(restored.getState().pinnedAgentIdsByWorkspace["srv:ws-b"]).toBeUndefined();
  });

  it("uses directory ownership before historical details when identifying foreign agents", () => {
    const own = makeAgent({ id: "own", cwd: "/repo", workspaceId: WORKSPACE_ID });
    const foreign = makeAgent({ id: "foreign", cwd: "/repo", workspaceId: "ws-2" });
    const unknown = makeAgent({ id: "unknown", cwd: "/repo" });
    const result = deriveWorkspaceAgentVisibility({
      workspaceId: WORKSPACE_ID,
      sessionAgents: new Map([
        [own.id, own],
        [foreign.id, foreign],
        [unknown.id, unknown],
      ]),
      agentDetails: new Map([
        [own.id, { ...own, workspaceId: "ws-2" }],
        [foreign.id, { ...foreign, workspaceId: WORKSPACE_ID }],
        [unknown.id, { ...unknown, workspaceId: "ws-2" }],
      ]),
    });

    expect(result.activeAgentIds).toEqual(new Set([own.id]));
    expect(result.foreignAgentIds).toEqual(new Set([foreign.id]));
  });

  it("recognizes foreign historical ownership without making archived or unknown agents foreign", () => {
    const archived = makeAgent({
      id: "archived",
      cwd: "/repo",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
    });
    const foreign = { ...archived, id: "foreign", workspaceId: "ws-2" };
    const unknown = { ...archived, id: "unknown", workspaceId: undefined };
    const result = deriveWorkspaceAgentVisibility({
      workspaceId: WORKSPACE_ID,
      sessionAgents: new Map(),
      agentDetails: new Map([
        [archived.id, archived],
        [foreign.id, foreign],
        [unknown.id, unknown],
      ]),
    });

    expect(result.activeAgentIds).toEqual(new Set());
    expect(result.foreignAgentIds).toEqual(new Set([foreign.id]));
  });

  it("keeps subagents active while excluding them from auto-open", () => {
    const parent = makeAgent({
      id: "parent-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
    });
    const child = makeAgent({
      id: "child-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: "parent-agent",
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([
        [parent.id, parent],
        [child.id, child],
      ]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["parent-agent", "child-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["parent-agent"]));
    expect(result.foreignAgentIds).toEqual(new Set());
  });

  it("excludes archived subagents from active and auto-open", () => {
    const archivedChild = makeAgent({
      id: "archived-child",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: "parent-agent",
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([[archivedChild.id, archivedChild]]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set<string>());
    expect(result.autoOpenAgentIds).toEqual(new Set<string>());
  });

  it("excludes a child from auto-open even when its snapshot arrives before the parent", () => {
    const child = makeAgent({
      id: "child-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: "parent-agent",
    });
    const parent = makeAgent({
      id: "parent-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([
        [child.id, child],
        [parent.id, parent],
      ]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["child-agent", "parent-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["parent-agent"]));
  });

  it("auto-opens a subagent whose parent belongs to another workspace", () => {
    const parent = makeAgent({
      id: "parent-agent",
      cwd: "/repo",
      workspaceId: "ws-parent",
    });
    const child = makeAgent({
      id: "child-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: parent.id,
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([
        [parent.id, parent],
        [child.id, child],
      ]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["child-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["child-agent"]));
  });

  it("excludes archived agents from the active directory", () => {
    const visible = makeAgent({
      id: "visible-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
    });
    const archived = makeAgent({
      id: "archived-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
      createdAt: new Date("2026-03-04T00:01:00.000Z"),
    });
    const otherWorkspace = makeAgent({
      id: "other-workspace-agent",
      cwd: "/repo/other",
      workspaceId: "ws-other",
    });

    const sessionAgents = new Map<string, Agent>([
      [visible.id, visible],
      [archived.id, archived],
      [otherWorkspace.id, otherWorkspace],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["visible-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["visible-agent"]));
  });

  it("does not make historical details active", () => {
    const active = makeAgent({
      id: "active-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
    });
    const historicalDetail = makeAgent({
      id: "historical-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map([[active.id, active]]),
      agentDetails: new Map([[historicalDetail.id, historicalDetail]]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["active-agent"]));
  });

  it("prunes archived agent tabs so archiving on one client closes tabs on all clients", () => {
    const activeAgentIds = new Set<string>();

    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "archived-agent",
        agentsHydrated: true,
        activeAgentIds,
      }),
    ).toBe(true);
  });

  it("prunes pinned archived agent tabs because archive state is authoritative", () => {
    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "archived-agent",
        agentsHydrated: true,
        activeAgentIds: new Set<string>(),
      }),
    ).toBe(true);
  });

  it("does not prune active agent tabs", () => {
    const activeAgentIds = new Set(["active-agent"]);

    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "active-agent",
        agentsHydrated: true,
        activeAgentIds,
      }),
    ).toBe(false);
  });

  it("prunes agent tabs once agents are hydrated and the agent is missing from activeAgentIds", () => {
    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "missing-agent",
        agentsHydrated: true,
        activeAgentIds: new Set<string>(),
      }),
    ).toBe(true);
  });

  it("matches agents by workspaceId regardless of cwd", () => {
    const sessionAgents = new Map<string, Agent>([
      [
        "stamped-agent",
        makeAgent({
          id: "stamped-agent",
          cwd: "/repo/subdir",
          workspaceId: "ws-1",
        }),
      ],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: "ws-1",
    });

    expect(result.activeAgentIds).toEqual(new Set(["stamped-agent"]));
  });

  it("excludes a stamped agent whose workspaceId belongs to another workspace sharing the cwd", () => {
    const sessionAgents = new Map<string, Agent>([
      [
        "other-ws-agent",
        makeAgent({
          id: "other-ws-agent",
          cwd: "/repo/worktree",
          workspaceId: "ws-2",
        }),
      ],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: "ws-1",
    });

    expect(result.activeAgentIds).toEqual(new Set<string>());
    expect(result.foreignAgentIds).toEqual(new Set(["other-ws-agent"]));
  });

  it("excludes agents without a workspaceId", () => {
    const sessionAgents = new Map<string, Agent>([
      ["ownerless-agent", makeAgent({ id: "ownerless-agent", cwd: "/repo/worktree" })],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: "ws-1",
    });

    expect(result.activeAgentIds).toEqual(new Set<string>());
    expect(result.foreignAgentIds).toEqual(new Set<string>());
  });

  it("builds the tab reconciliation snapshot without callers unpacking agent visibility", () => {
    const agentVisibility = {
      activeAgentIds: new Set(["active-agent"]),
      autoOpenAgentIds: new Set(["root-agent"]),
      foreignAgentIds: new Set(["foreign-agent"]),
    };

    expect(
      buildWorkspaceTabSnapshot({
        agentVisibility,
        agentsHydrated: true,
        terminalsHydrated: true,
        knownTerminalIds: ["terminal-1", "script-terminal"],
        standaloneTerminalIds: ["terminal-1"],
        hasActivePendingTerminalCreate: false,
        hasActivePendingDraftCreate: false,
      }),
    ).toEqual({
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: agentVisibility.activeAgentIds,
      autoOpenAgentIds: agentVisibility.autoOpenAgentIds,
      foreignAgentIds: agentVisibility.foreignAgentIds,
      knownTerminalIds: ["terminal-1", "script-terminal"],
      standaloneTerminalIds: ["terminal-1"],
      hasActivePendingTerminalCreate: false,
      hasActivePendingDraftCreate: false,
    });
  });

  describe("createWorkspaceAgentVisibilitySelector", () => {
    const SERVER_ID = "srv";

    class IterationCountingMap<K, V> extends Map<K, V> {
      iterations = 0;
      override values() {
        this.iterations += 1;
        return super.values();
      }
      override entries() {
        this.iterations += 1;
        return super.entries();
      }
      override [Symbol.iterator]() {
        this.iterations += 1;
        return super[Symbol.iterator]();
      }
    }

    function seedSession(agents: Map<string, Agent>): void {
      useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
      useSessionStore.getState().setAgents(SERVER_ID, agents);
    }

    function streamTick(text: string): void {
      useSessionStore.getState().setAgentStreamState(SERVER_ID, "parent-agent", {
        head: [
          {
            kind: "assistant_message",
            id: "message-1",
            text,
            timestamp: new Date("2026-03-04T00:02:00.000Z"),
          },
        ],
      });
    }

    const parent = makeAgent({ id: "parent-agent", cwd: "/repo", workspaceId: WORKSPACE_ID });
    const child = makeAgent({
      id: "child-agent",
      cwd: "/repo",
      workspaceId: WORKSPACE_ID,
      parentAgentId: parent.id,
    });
    const otherWorkspace = makeAgent({ id: "other-agent", cwd: "/other", workspaceId: "ws-2" });

    afterEach(() => {
      useSessionStore.getState().clearSession(SERVER_ID);
    });

    it("returns the cached result without walking agents when a stream tick leaves them unchanged", () => {
      const agents = new IterationCountingMap<string, Agent>([
        [parent.id, parent],
        [otherWorkspace.id, otherWorkspace],
      ]);
      seedSession(agents);
      const select = createWorkspaceAgentVisibilitySelector({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
      });
      const before = select(useSessionStore.getState());
      const iterationsAfterFirstSelect = agents.iterations;

      for (let tick = 0; tick < 100; tick += 1) {
        streamTick(`token ${tick}`);
        expect(select(useSessionStore.getState())).toBe(before);
      }

      expect(useSessionStore.getState().sessions[SERVER_ID]?.agents).toBe(agents);
      expect(agents.iterations).toBe(iterationsAfterFirstSelect);
      expect(before.activeAgentIds).toEqual(new Set([parent.id]));
    });

    it("recomputes when the agents map changes", () => {
      const agents = new Map([[parent.id, parent]]);
      seedSession(agents);
      const select = createWorkspaceAgentVisibilitySelector({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
      });
      const before = select(useSessionStore.getState());

      useSessionStore.getState().setAgents(SERVER_ID, new Map(agents).set(child.id, child));
      const after = select(useSessionStore.getState());

      expect(after).not.toBe(before);
      expect(after.activeAgentIds).toEqual(new Set([parent.id, child.id]));
      expect(after.autoOpenAgentIds).toEqual(new Set([parent.id]));
    });

    it("keeps the previous result when a changed agents map yields the same sets", () => {
      const agents = new Map([
        [parent.id, parent],
        [otherWorkspace.id, otherWorkspace],
      ]);
      seedSession(agents);
      const select = createWorkspaceAgentVisibilitySelector({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
      });
      const before = select(useSessionStore.getState());

      useSessionStore
        .getState()
        .setAgents(
          SERVER_ID,
          new Map(agents).set(otherWorkspace.id, { ...otherWorkspace, title: "Renamed" }),
        );

      expect(select(useSessionStore.getState())).toBe(before);
    });

    it("recomputes when agent details reveal a parent in another workspace", () => {
      seedSession(new Map([[child.id, child]]));
      const select = createWorkspaceAgentVisibilitySelector({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
      });
      expect(select(useSessionStore.getState()).autoOpenAgentIds).toEqual(new Set<string>());

      useSessionStore
        .getState()
        .setAgentDetails(
          SERVER_ID,
          new Map([[parent.id, { ...parent, workspaceId: "ws-parent" }]]),
        );
      const after = select(useSessionStore.getState());

      expect(after.activeAgentIds).toEqual(new Set([child.id]));
      expect(after.autoOpenAgentIds).toEqual(new Set([child.id]));
    });

    it("recomputes when only a previously unknown agent's foreign ownership becomes known", () => {
      seedSession(new Map([[parent.id, parent]]));
      const select = createWorkspaceAgentVisibilitySelector({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
      });
      const before = select(useSessionStore.getState());
      useSessionStore
        .getState()
        .setAgentDetails(SERVER_ID, new Map([[otherWorkspace.id, otherWorkspace]]));
      const after = select(useSessionStore.getState());

      expect(after).not.toBe(before);
      expect(after.activeAgentIds).toEqual(before.activeAgentIds);
      expect(after.autoOpenAgentIds).toEqual(before.autoOpenAgentIds);
      expect(after.foreignAgentIds).toEqual(new Set([otherWorkspace.id]));
    });
  });

  describe("workspaceAgentVisibilityEqual", () => {
    it("returns true for identical sets", () => {
      const a = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set(["c"]),
      };
      const b = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set(["c"]),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(true);
    });

    it("returns false when activeAgentIds differ", () => {
      const a = {
        activeAgentIds: new Set(["a"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set<string>(),
      };
      const b = {
        activeAgentIds: new Set(["b"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set<string>(),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(false);
    });

    it("returns false when autoOpenAgentIds differ", () => {
      const a = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set<string>(),
      };
      const b = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["b"]),
        foreignAgentIds: new Set<string>(),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(false);
    });

    it("returns true for empty sets", () => {
      const a = {
        activeAgentIds: new Set<string>(),
        autoOpenAgentIds: new Set<string>(),
        foreignAgentIds: new Set<string>(),
      };
      const b = {
        activeAgentIds: new Set<string>(),
        autoOpenAgentIds: new Set<string>(),
        foreignAgentIds: new Set<string>(),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(true);
    });
  });
});
