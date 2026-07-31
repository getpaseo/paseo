import { describe, expect, it } from "vitest";
import type { DaemonClient, FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { processAgentStreamEvent } from "@/timeline/session-stream-reducers";
import { AgentDirectoryReplica } from "./agent-replica";

function payload(input: {
  title: string;
  status?: AgentSnapshotPayload["status"];
  updatedAt?: string;
  archivedAt?: string | null;
}): AgentSnapshotPayload {
  return {
    id: "agent",
    provider: "codex",
    cwd: "/repo",
    model: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-07-17T00:01:00.000Z",
    lastUserMessageAt: null,
    status: input.status ?? "idle",
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
    title: input.title,
    labels: {},
    ...(input.archivedAt !== undefined ? { archivedAt: input.archivedAt } : {}),
  };
}

function entry(agent: AgentSnapshotPayload): FetchAgentsEntry {
  return {
    agent,
    project: {
      projectKey: "/repo",
      projectName: "repo",
      checkout: {
        cwd: "/repo",
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

describe("AgentDirectoryReplica", () => {
  it("detects an authoritative stop after the timeline optimistically becomes idle", () => {
    const serverId = "agent-replica-authoritative-transition";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const stoppedAgentIds: string[] = [];
    const replica = new AgentDirectoryReplica(serverId, (agentId) => stoppedAgentIds.push(agentId));
    replica.commitSnapshot([entry(payload({ title: "running", status: "running" }))], []);

    const runningAgent = useSessionStore.getState().sessions[serverId]?.agents.get("agent");
    if (!runningAgent) throw new Error("Expected running agent after authoritative snapshot");
    const timelineResult = processAgentStreamEvent({
      event: { type: "turn_completed", provider: "codex" },
      seq: undefined,
      epoch: undefined,
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      currentAgent: {
        status: runningAgent.status,
        updatedAt: runningAgent.updatedAt,
        lastActivityAt: runningAgent.lastActivityAt,
      },
      timestamp: new Date("2026-07-17T00:02:00.000Z"),
    });
    const timelineAgent = timelineResult.agent;
    if (!timelineAgent) throw new Error("Expected turn completion to update the agent");
    expect(timelineAgent.status).toBe("idle");
    store.setAgents(serverId, (current) => {
      const next = new Map(current);
      next.set("agent", { ...runningAgent, ...timelineAgent });
      return next;
    });

    replica.applyDelta({
      kind: "upsert",
      agent: payload({
        title: "idle",
        status: "idle",
        updatedAt: "2026-07-17T00:03:00.000Z",
      }),
      project: entry(payload({ title: "idle" })).project,
    });

    expect(stoppedAgentIds).toEqual(["agent"]);
    store.clearSession(serverId);
  });

  it("does not report an authoritative stop when the agent is archived", () => {
    const serverId = "agent-replica-archived-transition";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const stoppedAgentIds: string[] = [];
    const replica = new AgentDirectoryReplica(serverId, (agentId) => stoppedAgentIds.push(agentId));
    const running = payload({ title: "running", status: "running" });
    replica.commitSnapshot([entry(running)], []);

    replica.applyDelta({
      kind: "upsert",
      agent: payload({
        title: "archived",
        status: "idle",
        updatedAt: "2026-07-17T00:03:00.000Z",
        archivedAt: "2026-07-17T00:02:00.000Z",
      }),
      project: entry(running).project,
    });

    expect(stoppedAgentIds).toEqual([]);
    store.clearSession(serverId);
  });

  it("keeps membership authoritative across remove, stale timeline, and re-add", () => {
    const serverId = "agent-replica";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(serverId, () => undefined);
    replica.commitSnapshot([entry(payload({ title: "directory" }))], []);
    const directoryPlacement = useSessionStore
      .getState()
      .sessions[serverId]?.agents.get("agent")?.projectPlacement;
    expect(directoryPlacement).toBeDefined();
    const staleToken = replica.captureTimeline("agent");

    replica.remove("agent");
    expect(replica.submitTimelineAgent(staleToken, payload({ title: "stale" }))).toBe(false);
    expect(useSessionStore.getState().sessions[serverId]?.agents.has("agent")).toBe(false);

    replica.applyDelta({
      kind: "upsert",
      agent: payload({ title: "re-added" }),
      project: entry(payload({ title: "x" })).project,
    });
    expect(replica.submitTimelineAgent(staleToken, payload({ title: "still stale" }))).toBe(false);
    const currentToken = replica.captureTimeline("agent");
    expect(replica.submitTimelineAgent(currentToken, payload({ title: "current" }))).toBe(true);
    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.title).toBe(
      "current",
    );
    expect(
      useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.projectPlacement,
    ).toEqual(directoryPlacement);
    store.clearSession(serverId);
  });
});
