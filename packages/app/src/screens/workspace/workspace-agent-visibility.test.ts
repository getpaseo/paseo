import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import {
  deriveWorkspaceAgentVisibility,
  shouldPruneWorkspaceAgentTab,
  workspaceAgentVisibilityEqual,
} from "@/screens/workspace/workspace-agent-visibility";

function makeAgent(input: {
  id: string;
  cwd: string;
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
    model: null,
    thinkingOptionId: null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: input.archivedAt ?? null,
  };
}

describe("workspace agent visibility", () => {
  it("keeps archived agents out of activeAgentIds but present in knownAgentIds", () => {
    const workspaceDirectory = "/repo/worktree";
    const visible = makeAgent({
      id: "visible-agent",
      cwd: workspaceDirectory,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
    });
    const archived = makeAgent({
      id: "archived-agent",
      cwd: workspaceDirectory,
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
      createdAt: new Date("2026-03-04T00:01:00.000Z"),
    });
    const otherWorkspace = makeAgent({
      id: "other-workspace-agent",
      cwd: "/repo/other",
    });

    const sessionAgents = new Map<string, Agent>([
      [visible.id, visible],
      [archived.id, archived],
      [otherWorkspace.id, otherWorkspace],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceDirectory,
    });

    expect(result.activeAgentIds).toEqual(new Set(["visible-agent"]));
    expect(result.knownAgentIds.has("visible-agent")).toBe(true);
    expect(result.knownAgentIds.has("archived-agent")).toBe(true);
    expect(result.knownAgentIds.has("other-workspace-agent")).toBe(false);
  });

  it("prunes archived agent tabs so archiving on one client closes tabs on all clients", () => {
    const knownAgentIds = new Set(["archived-agent"]);
    const activeAgentIds = new Set<string>();

    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "archived-agent",
        agentsHydrated: true,
        knownAgentIds,
        activeAgentIds,
      }),
    ).toBe(true);
  });

  it("prunes pinned archived agent tabs because archive state is authoritative", () => {
    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "archived-agent",
        agentsHydrated: true,
        knownAgentIds: new Set(["archived-agent"]),
        activeAgentIds: new Set<string>(),
      }),
    ).toBe(true);
  });

  it("does not prune active agent tabs", () => {
    const knownAgentIds = new Set(["active-agent"]);
    const activeAgentIds = new Set(["active-agent"]);

    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "active-agent",
        agentsHydrated: true,
        knownAgentIds,
        activeAgentIds,
      }),
    ).toBe(false);
  });

  it("prunes agent tabs once agents are hydrated and the agent is missing from knownAgentIds", () => {
    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "missing-agent",
        agentsHydrated: true,
        knownAgentIds: new Set<string>(),
        activeAgentIds: new Set<string>(),
      }),
    ).toBe(true);
  });

  it("matches workspace agents when cwd and route workspace differ only by trailing slash", () => {
    const sessionAgents = new Map<string, Agent>([
      [
        "slash-agent",
        makeAgent({
          id: "slash-agent",
          cwd: "/Users/moboudra/.paseo/worktrees/1luy0po7/normal-squid/",
        }),
      ],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceDirectory: "/Users/moboudra/.paseo/worktrees/1luy0po7/normal-squid",
    });

    expect(result.activeAgentIds).toEqual(new Set(["slash-agent"]));
    expect(result.knownAgentIds.has("slash-agent")).toBe(true);
  });

  it("matches workspace agents using the workspace directory even when the route uses a numeric workspace id", () => {
    const sessionAgents = new Map<string, Agent>([
      [
        "recent-agent",
        makeAgent({
          id: "recent-agent",
          cwd: "/tmp/workspace-lifecycle-main",
        }),
      ],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceDirectory: "/tmp/workspace-lifecycle-main",
    });

    expect(result.activeAgentIds).toEqual(new Set(["recent-agent"]));
    expect(result.knownAgentIds).toEqual(new Set(["recent-agent"]));
  });

  describe("workspaceAgentVisibilityEqual", () => {
    it("returns true for identical sets", () => {
      const a = { activeAgentIds: new Set(["a", "b"]), knownAgentIds: new Set(["a", "b", "c"]) };
      const b = { activeAgentIds: new Set(["a", "b"]), knownAgentIds: new Set(["a", "b", "c"]) };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(true);
    });

    it("returns false when activeAgentIds differ", () => {
      const a = { activeAgentIds: new Set(["a"]), knownAgentIds: new Set(["a"]) };
      const b = { activeAgentIds: new Set(["b"]), knownAgentIds: new Set(["a"]) };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(false);
    });

    it("returns false when knownAgentIds differ", () => {
      const a = { activeAgentIds: new Set(["a"]), knownAgentIds: new Set(["a"]) };
      const b = { activeAgentIds: new Set(["a"]), knownAgentIds: new Set(["a", "b"]) };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(false);
    });

    it("returns true for empty sets", () => {
      const a = { activeAgentIds: new Set<string>(), knownAgentIds: new Set<string>() };
      const b = { activeAgentIds: new Set<string>(), knownAgentIds: new Set<string>() };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(true);
    });
  });
});
