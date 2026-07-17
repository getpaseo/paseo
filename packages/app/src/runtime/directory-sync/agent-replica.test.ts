import { describe, expect, it } from "vitest";
import type { DaemonClient, FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { AgentDirectoryReplica } from "./agent-replica";

function payload(title: string): AgentSnapshotPayload {
  return {
    id: "agent",
    provider: "codex",
    cwd: "/repo",
    model: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:01:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
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
    title,
    labels: {},
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
  it("keeps membership authoritative across remove, stale timeline, and re-add", () => {
    const serverId = "agent-replica";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(serverId, () => undefined);
    replica.commitSnapshot([entry(payload("directory"))], []);
    const directoryPlacement = useSessionStore
      .getState()
      .sessions[serverId]?.agents.get("agent")?.projectPlacement;
    expect(directoryPlacement).toBeDefined();
    const staleToken = replica.captureTimeline("agent");

    replica.remove("agent");
    expect(replica.submitTimelineAgent(staleToken, payload("stale"))).toBe(false);
    expect(useSessionStore.getState().sessions[serverId]?.agents.has("agent")).toBe(false);

    replica.applyDelta({
      kind: "upsert",
      agent: payload("re-added"),
      project: entry(payload("x")).project,
    });
    expect(replica.submitTimelineAgent(staleToken, payload("still stale"))).toBe(false);
    const currentToken = replica.captureTimeline("agent");
    expect(replica.submitTimelineAgent(currentToken, payload("current"))).toBe(true);
    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.title).toBe(
      "current",
    );
    expect(
      useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.projectPlacement,
    ).toEqual(directoryPlacement);
    store.clearSession(serverId);
  });
});
