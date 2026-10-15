import { describe, expect, it } from "vitest";
import type { Agent, SessionState, WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { nextAttentionAgent } from "./next-attention-agent";

const workspace = {
  id: "w1",
  status: "active",
  archivingAt: null,
} as unknown as WorkspaceDescriptor;
function agent(id: string, reason: Agent["attentionReason"], timestamp: number, extra = {}) {
  return {
    id,
    serverId: "h1",
    workspaceId: "w1",
    parentAgentId: null,
    requiresAttention: true,
    attentionReason: reason,
    attentionTimestamp: new Date(timestamp),
    updatedAt: new Date(timestamp),
    pendingPermissions: [],
    archivedAt: null,
    ...extra,
  } as unknown as Agent;
}
function pick(
  agents: Agent[],
  current: { serverId: string; agentId: string },
  options: {
    connected?: string[];
    workspaceIds?: string[];
    tabs?: WorkspaceTab[];
  } = {},
) {
  const sessions: Record<string, Pick<SessionState, "agents" | "workspaces">> = {};
  for (const item of agents) {
    sessions[item.serverId] ??= { agents: new Map(), workspaces: new Map() };
    sessions[item.serverId].agents.set(item.id, item);
    for (const id of options.workspaceIds ?? ["w1"]) {
      sessions[item.serverId].workspaces.set(id, { ...workspace, id });
    }
  }
  return nextAttentionAgent({
    sessions,
    connectedServerIds: new Set(options.connected ?? ["h1", "h2"]),
    getWorkspaceTabs: () => options.tabs ?? [],
    current,
  });
}

describe("nextAttentionAgent", () => {
  it("orders permissions, errors, then replies by oldest timestamp and wraps", () => {
    const agents = [
      agent("reply", "finished", 1),
      agent("error", "error", 2),
      agent("new-permission", "permission", 4),
      agent("old-permission", "permission", 3),
    ];
    expect(pick(agents, { serverId: "h1", agentId: "other" })?.id).toBe("old-permission");
    expect(pick(agents, { serverId: "h1", agentId: "old-permission" })?.id).toBe("new-permission");
    expect(pick(agents, { serverId: "h1", agentId: "reply" })?.id).toBe("old-permission");
  });

  it("crosses workspaces and hosts while excluding unavailable targets", () => {
    const agents = [
      agent("current", "permission", 1),
      agent("other-workspace", "error", 2, { workspaceId: "w2" }),
      agent("other-host", "finished", 3, { serverId: "h2" }),
      agent("archived", "permission", 0, { archivedAt: new Date() }),
      agent("missing-workspace", "permission", 0, { workspaceId: "missing" }),
    ];
    expect(
      pick(agents, { serverId: "h1", agentId: "current" }, { workspaceIds: ["w1", "w2"] })?.id,
    ).toBe("other-workspace");
    expect(
      pick(agents, { serverId: "h1", agentId: "other-workspace" }, { connected: ["h1"] })?.id,
    ).toBe("current");
    expect(pick([agents[0]], { serverId: "h1", agentId: "current" })).toBeNull();
  });

  it("includes only subagents with an open agent tab", () => {
    const child = agent("child", "permission", 1, { parentAgentId: "parent" });
    expect(pick([child], { serverId: "h1", agentId: "other" })).toBeNull();
    expect(
      pick(
        [child],
        { serverId: "h1", agentId: "other" },
        {
          tabs: [{ tabId: "child-tab", target: { kind: "agent", agentId: "child" }, createdAt: 1 }],
        },
      )?.id,
    ).toBe("child");
  });

  it("keeps unresolved permissions actionable even without an unread flag", () => {
    const permission = agent("permission", null, 3, {
      requiresAttention: false,
      pendingPermissions: [{ id: "request" }],
    });
    const error = agent("error", "error", 1);
    expect(pick([error, permission], { serverId: "h1", agentId: "other" })?.id).toBe("permission");
    expect(pick([permission], { serverId: "h1", agentId: "permission" })).toBeNull();
  });
});
