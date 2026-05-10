import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { reconcilePreviousAgentStatuses } from "./session-status-tracking";

function createAgent(status: Agent["status"]): Agent {
  return {
    serverId: "server-1",
    id: "agent-1",
    provider: "codex",
    status,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastUserMessageAt: null,
    lastActivityAt: new Date(0),
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
    title: "Agent",
    cwd: "/tmp",
    model: null,
    parentAgentId: null,
    labels: {},
    projectPlacement: null,
  };
}

describe("reconcilePreviousAgentStatuses", () => {
  it("preserves previously seen status for existing agents", () => {
    const previous = new Map([["agent-1", "running" as const]]);
    const sessionAgents = new Map([["agent-1", createAgent("idle")]]);

    const result = reconcilePreviousAgentStatuses(previous, sessionAgents);

    expect(result).toEqual(new Map([["agent-1", "running"]]));
  });

  it("seeds newly seen agents from the current snapshot", () => {
    const sessionAgents = new Map([["agent-1", createAgent("idle")]]);

    const result = reconcilePreviousAgentStatuses(new Map(), sessionAgents);

    expect(result).toEqual(new Map([["agent-1", "idle"]]));
  });

  it("removes agents that are no longer present", () => {
    const previous = new Map([
      ["agent-1", "running" as const],
      ["agent-2", "idle" as const],
    ]);
    const sessionAgents = new Map([["agent-1", createAgent("idle")]]);

    const result = reconcilePreviousAgentStatuses(previous, sessionAgents);

    expect(result).toEqual(new Map([["agent-1", "running"]]));
  });

  it("clears all tracked statuses when the session is unavailable", () => {
    const previous = new Map([["agent-1", "running" as const]]);

    const result = reconcilePreviousAgentStatuses(previous, undefined);

    expect(result).toEqual(new Map());
  });
});
