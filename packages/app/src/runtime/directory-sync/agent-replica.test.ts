import { describe, expect, it } from "vitest";
import type { DaemonClient, FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import {
  selectAgentTimelineState,
  selectAgentTurnPresentation,
  useSessionStore,
} from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import type { DirectoryReplicaMutation } from "@/runtime/replica-cache";
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
  it.each(["delta", "snapshot", "timeline"] as const)(
    "preserves equal features across %s updates while accepting real changes",
    (source) => {
      const serverId = `agent-replica-features-${source}`;
      const store = useSessionStore.getState();
      store.initializeSession(serverId, null);
      const replica = new AgentDirectoryReplica(
        serverId,
        () => undefined,
        () => undefined,
      );
      const update = (agent: AgentSnapshotPayload) => {
        const updates = {
          delta: () => replica.applyDelta({ kind: "upsert", ...entry(agent) }),
          snapshot: () => replica.commitSnapshot([entry(agent)], []),
          timeline: () => replica.submitTimelineAgent(replica.captureTimeline(agent.id), agent),
        };
        updates[source]();
        return useSessionStore.getState().sessions[serverId]!.agents.get(agent.id)!;
      };

      const initial = update({ ...payload("initial"), features: [] });
      const empty = update({
        ...payload("empty update"),
        updatedAt: "2026-07-17T00:02:00.000Z",
        features: [],
      });
      expect(empty.title).toBe("empty update");
      expect(empty.updatedAt.toISOString()).toBe("2026-07-17T00:02:00.000Z");
      expect(empty.features).toBe(initial.features);

      const feature = {
        type: "select" as const,
        id: "speed",
        label: "Speed",
        value: "fast",
        options: [{ id: "fast", label: "Fast" }],
      };
      const added = update({
        ...payload("added"),
        updatedAt: empty.updatedAt.toISOString(),
        features: [feature],
      });
      expect(added.features).toEqual([feature]);
      expect(added.features).not.toBe(empty.features);
      const unchanged = update({
        ...payload("unchanged"),
        updatedAt: empty.updatedAt.toISOString(),
        features: [{ ...feature, options: [{ ...feature.options[0] }] }],
      });
      expect(unchanged.features).toBe(added.features);

      const changedFeature = { ...feature, options: [{ id: "fast", label: "Faster" }] };
      const changed = update({
        ...payload("changed"),
        updatedAt: empty.updatedAt.toISOString(),
        features: [changedFeature],
      });
      expect(changed.features).toEqual([changedFeature]);
      expect(changed.features).not.toBe(unchanged.features);
      const removed = update({ ...payload("removed"), updatedAt: empty.updatedAt.toISOString() });
      expect(removed.features).toBeUndefined();
      store.clearSession(serverId);
    },
  );

  it.each(["delta", "snapshot"] as const)(
    "does not erase freshly fetched history when the active directory removes it by %s",
    (removal) => {
      const serverId = `agent-replica-history-${removal}`;
      const store = useSessionStore.getState();
      store.initializeSession(serverId, null);
      const replica = new AgentDirectoryReplica(
        serverId,
        () => undefined,
        () => undefined,
      );
      const archived = { ...payload("archived"), archivedAt: "2026-09-11T00:00:00.000Z" };
      replica.submitTimelineAgent(replica.captureTimeline("agent"), archived);
      store.applyAgentTimelineResponseState(serverId, "agent", {
        items: [
          {
            kind: "assistant_message",
            id: "reply",
            text: "server history",
            timestamp: new Date(),
            timelineCursor: { epoch: "e", seq: 1 },
          },
        ],
        head: [],
        range: { epoch: "e", startSeq: 1, endSeq: 1 },
        older: "none",
        newer: false,
        synchronized: true,
        acknowledgedClientMessageIds: [],
      });
      if (removal === "delta") replica.applyDelta({ kind: "remove", agentId: "agent" });
      else replica.commitSnapshot([], []);
      expect(selectAgentTimelineState(store.getSession(serverId), "agent")).toMatchObject({
        status: "synced",
        items: [{ text: "server history" }],
      });
      replica.remove("agent");
      expect(selectAgentTimelineState(store.getSession(serverId), "agent")).toMatchObject({
        status: "cold",
      });
      store.clearSession(serverId);
    },
  );

  it("does not let a late cache read replace newer live turn state", () => {
    const serverId = "agent-replica-late-cache";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      () => undefined,
    );
    replica.commitSnapshot([entry(payload("live"))], []);
    replica.applyTurnLiveness("agent", {
      type: "stream_open",
      turn: { turnId: "turn-live", startedAt: null },
    });

    replica.commitCached(new Map([["agent", normalizeAgentSnapshot(payload("cached"), serverId)]]));

    expect(selectAgentTurnPresentation(store.getSession(serverId), "agent").turnId).toBe(
      "turn-live",
    );
    store.clearSession(serverId);
  });

  it("accepts the requested agent from the authoritative timeline after a cache miss", () => {
    const serverId = "agent-replica-cache-miss";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      () => undefined,
    );

    expect(replica.submitTimelineAgent(replica.captureTimeline("agent"), payload("network"))).toBe(
      true,
    );
    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.title).toBe(
      "network",
    );
    store.clearSession(serverId);
  });

  it("persists stream-only turn transitions through the agent owner", () => {
    const serverId = "agent-replica-stream-turn";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const commits: DirectoryReplicaMutation[][] = [];
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      (mutations) => commits.push([...mutations]),
    );
    replica.commitSnapshot([entry(payload("agent"))], []);
    commits.length = 0;

    replica.applyTurnLiveness("agent", {
      type: "stream_open",
      turn: { turnId: "turn-1", startedAt: new Date("2026-08-31T12:00:00.000Z") },
    });

    expect(commits).toEqual([
      [
        expect.objectContaining({
          kind: "agent",
          type: "upsert",
          id: "agent",
          value: expect.objectContaining({
            status: "idle",
            turn: {
              phase: "open",
              cancellationRequestId: null,
              turnId: "turn-1",
              startedAt: new Date("2026-08-31T12:00:00.000Z"),
            },
          }),
        }),
      ],
    ]);
    expect(selectAgentTurnPresentation(store.getSession(serverId), "agent").isActive).toBe(true);
    store.clearSession(serverId);
  });

  it("notifies the queue owner exactly once when a stream turn closes", () => {
    const serverId = "agent-replica-stream-stop";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const stopped: string[] = [];
    const replica = new AgentDirectoryReplica(
      serverId,
      (agentId) => stopped.push(agentId),
      () => undefined,
    );
    replica.commitSnapshot([entry(payload("agent"))], []);
    replica.applyTurnLiveness("agent", {
      type: "stream_open",
      turn: { turnId: "turn-1", startedAt: null },
    });

    replica.applyTurnLiveness("agent", { type: "stream_close", turnId: "turn-1" });
    replica.applyTurnLiveness("agent", { type: "stream_close", turnId: "turn-1" });

    expect(stopped).toEqual(["agent"]);
    store.clearSession(serverId);
  });

  it("preserves cancellation state when the same active turn is snapshotted", () => {
    const serverId = "agent-replica-cancellation-snapshot";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      () => undefined,
    );
    replica.commitSnapshot(
      [
        entry({
          ...payload("running"),
          activeTurn: { turnId: "turn-1", startedAt: null },
        }),
      ],
      [],
    );
    replica.applyTurnLiveness("agent", { type: "cancellation_started", requestId: 7 });

    replica.applyDelta({
      kind: "upsert",
      agent: {
        ...payload("same running turn"),
        activeTurn: { turnId: "turn-1", startedAt: null },
      },
      project: entry(payload("project")).project,
    });

    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.turn).toMatchObject({
      phase: "open",
      turnId: "turn-1",
      cancellationRequestId: 7,
    });

    replica.commitSnapshot(
      [
        entry({
          ...payload("same turn from refresh"),
          activeTurn: { turnId: "turn-1", startedAt: null },
        }),
      ],
      [],
    );
    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.turn).toMatchObject({
      phase: "open",
      turnId: "turn-1",
      cancellationRequestId: 7,
    });
    store.clearSession(serverId);
  });

  it("uses turn liveness for stopped transitions even when protocol status disagrees", () => {
    const serverId = "agent-replica-mismatched-status";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const stopped: string[] = [];
    const replica = new AgentDirectoryReplica(
      serverId,
      (agentId) => stopped.push(agentId),
      () => undefined,
    );
    replica.commitSnapshot(
      [
        entry({
          ...payload("open despite idle"),
          activeTurn: { turnId: "turn-1", startedAt: null },
        }),
      ],
      [],
    );

    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")).toMatchObject({
      status: "idle",
      turn: { phase: "open", turnId: "turn-1" },
    });

    replica.applyDelta({
      kind: "upsert",
      agent: { ...payload("idle turn despite running"), status: "running", activeTurn: null },
      project: entry(payload("project")).project,
    });
    replica.applyDelta({
      kind: "upsert",
      agent: { ...payload("status-only update"), status: "idle", activeTurn: null },
      project: entry(payload("project")).project,
    });

    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")).toMatchObject({
      status: "idle",
      turn: { phase: "idle" },
    });
    expect(stopped).toEqual(["agent"]);
    store.clearSession(serverId);
  });

  it("preserves an unchanged running agent's turn identity during catch-up", () => {
    const serverId = "agent-replica-catch-up";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      () => undefined,
    );
    replica.commitSnapshot(
      [
        entry({
          ...payload("running"),
          status: "running",
          activeTurn: { turnId: "turn-1", startedAt: "2026-07-17T00:01:00.000Z" },
        }),
      ],
      [],
    );

    replica.commitChanges([], [], []);

    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.turn).toEqual({
      phase: "open",
      turnId: "turn-1",
      startedAt: new Date("2026-07-17T00:01:00.000Z"),
      cancellationRequestId: null,
    });
    store.clearSession(serverId);
  });

  it("keeps membership authoritative across remove, stale timeline, and re-add", () => {
    const serverId = "agent-replica";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      () => undefined,
    );
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

  it("keeps a timeline-hydrated agent when a sequenced catch-up carries no entries", () => {
    const serverId = "agent-replica-timeline-membership";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      () => undefined,
    );

    // A conversation opened from history arrives over its timeline, without the
    // project placement the directory carries, and is a member from then on.
    replica.submitTimelineAgent(replica.captureTimeline("agent"), payload("timeline only"));
    expect(useSessionStore.getState().sessions[serverId]?.agents.has("agent")).toBe(true);

    replica.commitChanges([], [], []);

    expect(useSessionStore.getState().sessions[serverId]?.agents.has("agent")).toBe(true);
    store.clearSession(serverId);
  });
});
