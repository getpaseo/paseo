import { describe, expect, it } from "vitest";
import type { FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { Agent } from "@/stores/session-store";
import { reconcileAgentDirectory } from "./agent-directory-reconciliation";

function snapshot(id: string, status: AgentSnapshotPayload["status"]): AgentSnapshotPayload {
  return {
    id,
    provider: "codex",
    cwd: "/repo",
    model: null,
    createdAt: "2026-07-12T10:00:00.000Z",
    updatedAt: "2026-07-12T10:00:00.000Z",
    lastUserMessageAt: null,
    status,
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
    title: null,
    labels: {},
  };
}

function entry(id: string, status: AgentSnapshotPayload["status"]): FetchAgentsEntry {
  return {
    agent: snapshot(id, status),
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

function replica(id: string, status: Agent["status"]): Agent {
  return {
    ...snapshot(id, status),
    serverId: "server",
    createdAt: new Date("2026-07-12T10:00:00.000Z"),
    updatedAt: new Date("2026-07-12T10:00:00.000Z"),
    lastActivityAt: new Date("2026-07-12T10:00:00.000Z"),
    lastUserMessageAt: null,
    attentionTimestamp: null,
    archivedAt: null,
    parentAgentId: null,
  };
}

describe("agent directory reconciliation", () => {
  it("reports snapshot-only and buffered running transitions exactly once", () => {
    const result = reconcileAgentDirectory({
      previous: new Map([
        ["snapshot", replica("snapshot", "running")],
        ["buffered", replica("buffered", "running")],
      ]),
      snapshot: [entry("snapshot", "idle"), entry("buffered", "running")],
      deltas: [
        {
          kind: "upsert",
          agent: snapshot("buffered", "idle"),
          project: entry("buffered", "idle").project,
        },
        {
          kind: "upsert",
          agent: snapshot("buffered", "idle"),
          project: entry("buffered", "idle").project,
        },
      ],
    });

    expect(result.stoppedRunningAgentIds).toEqual(["snapshot", "buffered"]);
    expect(result.entries.map(({ agent }) => [agent.id, agent.status])).toEqual([
      ["snapshot", "idle"],
      ["buffered", "idle"],
    ]);
  });

  it("preserves ordered upserts and removals received after page one", () => {
    const result = reconcileAgentDirectory({
      previous: new Map(),
      snapshot: [entry("updated", "idle"), entry("removed", "idle")],
      deltas: [
        {
          kind: "upsert",
          agent: { ...snapshot("updated", "idle"), title: "live" },
          project: entry("updated", "idle").project,
        },
        { kind: "remove", agentId: "removed" },
      ],
    });

    expect(result.entries.map(({ agent }) => [agent.id, agent.title])).toEqual([
      ["updated", "live"],
    ]);
  });

  it("keeps newer page metadata when a stale buffered upsert arrives", () => {
    const snapshotEntry = entry("agent", "running");
    const staleProject = {
      ...snapshotEntry.project,
      projectName: "stale project",
    };
    const result = reconcileAgentDirectory({
      previous: new Map([["agent", replica("agent", "running")]]),
      snapshot: [
        {
          ...entry("agent", "running"),
          agent: {
            ...snapshot("agent", "running"),
            title: "newer page",
            updatedAt: "2026-07-12T12:00:00.000Z",
          },
        },
      ],
      deltas: [
        {
          kind: "upsert",
          agent: {
            ...snapshot("agent", "idle"),
            title: "stale live",
            updatedAt: "2026-07-12T11:00:00.000Z",
          },
          project: staleProject,
        },
      ],
    });

    expect({
      title: result.entries[0]?.agent.title,
      status: result.entries[0]?.agent.status,
      projectName: result.entries[0]?.project.projectName,
      stopped: result.stoppedRunningAgentIds,
    }).toEqual({ title: "newer page", status: "running", projectName: "repo", stopped: [] });
  });

  it("clears a snapshot stop when a newer buffered upsert is running", () => {
    const result = reconcileAgentDirectory({
      previous: new Map([["agent", replica("agent", "running")]]),
      snapshot: [entry("agent", "idle")],
      deltas: [
        {
          kind: "upsert",
          agent: {
            ...snapshot("agent", "running"),
            updatedAt: "2026-07-12T11:00:00.000Z",
          },
          project: entry("agent", "running").project,
        },
      ],
    });

    expect(result.entries[0]?.agent.status).toBe("running");
    expect(result.stoppedRunningAgentIds).toEqual([]);
  });

  it("accepts usage from a stale buffered upsert without regressing metadata", () => {
    const result = reconcileAgentDirectory({
      previous: new Map(),
      snapshot: [
        {
          ...entry("agent", "idle"),
          agent: {
            ...snapshot("agent", "idle"),
            title: "newer page",
            updatedAt: "2026-07-12T12:00:00.000Z",
            lastUsage: { inputTokens: 10, outputTokens: 5 },
          },
        },
      ],
      deltas: [
        {
          kind: "upsert",
          agent: {
            ...snapshot("agent", "running"),
            title: "stale live",
            updatedAt: "2026-07-12T11:00:00.000Z",
            lastUsage: { inputTokens: 20, outputTokens: 8 },
          },
          project: entry("agent", "idle").project,
        },
      ],
    });

    expect({
      title: result.entries[0]?.agent.title,
      status: result.entries[0]?.agent.status,
      usage: result.entries[0]?.agent.lastUsage,
    }).toEqual({
      title: "newer page",
      status: "idle",
      usage: { inputTokens: 20, outputTokens: 8 },
    });
  });

  it("preserves usage when a stale buffered upsert omits it", () => {
    const result = reconcileAgentDirectory({
      previous: new Map(),
      snapshot: [
        {
          ...entry("agent", "idle"),
          agent: {
            ...snapshot("agent", "idle"),
            updatedAt: "2026-07-12T12:00:00.000Z",
            lastUsage: { inputTokens: 10, outputTokens: 5 },
          },
        },
      ],
      deltas: [
        {
          kind: "upsert",
          agent: {
            ...snapshot("agent", "running"),
            updatedAt: "2026-07-12T11:00:00.000Z",
          },
          project: entry("agent", "idle").project,
        },
      ],
    });

    expect(result.entries[0]?.agent.lastUsage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});
