import type { FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { clearArchiveAgentPending } from "@/hooks/use-archive-agent";
import { queryClient } from "@/data/query-client";
import type { Agent } from "@/stores/session-store";
import { normalizeAgentSnapshot, projectAgentSnapshot } from "@/utils/agent-snapshots";
import { type AgentDirectoryDelta, type AgentRemovalReason } from "@/utils/agent-directory-sync";
import { reconcileAgentDirectory } from "@/utils/agent-directory-reconciliation";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";
import type { DirectoryReplicaMutation } from "@/runtime/replica-cache";
import type { TurnLivenessTransition } from "@/timeline/turn-liveness";
import { AgentStoreProjection } from "./internal/agent-store";

function projectAgentDirectoryEntry(agent: Agent): FetchAgentsEntry | null {
  return agent.projectPlacement
    ? { agent: projectAgentSnapshot(agent), project: agent.projectPlacement }
    : null;
}

export interface AgentLifecycleToken {
  readonly agentId: string;
  readonly version: number;
}

export class AgentDirectoryReplica {
  private readonly lifecycleVersions = new Map<string, number>();
  private readonly members = new Set<string>();
  private readonly storeProjection: AgentStoreProjection;

  constructor(
    private readonly serverId: string,
    private readonly onStoppedRunning: (agentId: string) => void,
    private readonly persist: (mutations: readonly DirectoryReplicaMutation[]) => void,
    removeTimeline: (agentId: string, reason: AgentRemovalReason) => void,
    private readonly acceptTimeline: (agentId: string) => void = () => undefined,
  ) {
    this.storeProjection = new AgentStoreProjection(serverId, removeTimeline);
  }

  captureTimeline(agentId: string): AgentLifecycleToken {
    return { agentId, version: this.lifecycleVersions.get(agentId) ?? 0 };
  }

  isTimelineCurrent(token: AgentLifecycleToken): boolean {
    return token.version === (this.lifecycleVersions.get(token.agentId) ?? 0);
  }

  snapshot(): Map<string, Agent> {
    return this.storeProjection.snapshot();
  }

  // Saved rows sit under whatever the live stream already delivered for this connection.
  commitCached(agents: Map<string, Agent>): void {
    const current = new Map(
      [...agents].filter(([id]) => !this.lifecycleVersions.has(id) || this.members.has(id)),
    );
    const merged = this.storeProjection.commitCached(current);
    this.members.clear();
    for (const agentId of merged.keys()) {
      this.members.add(agentId);
    }
  }

  submitTimelineAgent(token: AgentLifecycleToken, payload: AgentSnapshotPayload): boolean {
    if (!this.isTimelineCurrent(token)) {
      return false;
    }
    const startsLifetime = !this.members.has(token.agentId);
    const existing = this.storeProjection.get(token.agentId);
    const timelineAgent = applyLegacyDaemonWorkspaceOwnership({
      serverId: this.serverId,
      agent: normalizeAgentSnapshot(payload, this.serverId),
    });
    const normalized: Agent = {
      ...timelineAgent,
      projectPlacement: timelineAgent.projectPlacement ?? existing?.projectPlacement,
    };
    const accepted = this.storeProjection.accept(normalized);
    if (startsLifetime) {
      this.resume(accepted.id);
      this.acceptTimeline(accepted.id);
    }
    this.members.add(accepted.id);
    this.storeProjection.replacePendingPermissions(accepted);
    this.storeProjection.publishActivity(accepted);
    if (accepted.archivedAt) {
      clearArchiveAgentPending({ queryClient, serverId: this.serverId, agentId: accepted.id });
    }
    this.persist([this.agentUpsert(accepted)]);
    return true;
  }

  applyDelta(delta: AgentDirectoryDelta): void {
    const before = this.members.has(delta.kind === "remove" ? delta.agentId : delta.agent.id);
    const result = this.storeProjection.applyDelta(delta);
    if (delta.kind === "remove") {
      this.members.delete(delta.agentId);
      this.advance(delta.agentId);
    } else {
      this.members.add(delta.agent.id);
      if (!before) {
        this.resume(delta.agent.id);
        this.acceptTimeline(delta.agent.id);
      }
    }
    if (result.stoppedRunning) this.onStoppedRunning(result.agentId);
    this.persist(
      result.agent
        ? [this.agentUpsert(result.agent)]
        : [{ kind: "agent", type: "delete", id: result.agentId }],
    );
  }

  accept(agent: Agent): Agent {
    const startsLifetime = !this.members.has(agent.id);
    const accepted = this.storeProjection.accept(agent);
    if (startsLifetime) {
      this.resume(accepted.id);
      this.acceptTimeline(accepted.id);
    }
    this.members.add(accepted.id);
    this.persist([this.agentUpsert(accepted)]);
    return accepted;
  }

  commitSnapshot(
    entries: FetchAgentsEntry[],
    deltas: readonly AgentDirectoryDelta[],
    persist = true,
  ): Map<string, Agent> {
    const previous = this.storeProjection.snapshot();
    const reconciled = reconcileAgentDirectory({ snapshot: entries, deltas });
    const nextIds = new Set(reconciled.map((entry) => entry.agent.id));
    const startedLifetimes = new Set<string>();
    for (const agentId of this.members) {
      if (!nextIds.has(agentId)) this.advance(agentId);
    }
    for (const agentId of nextIds) {
      if (!this.members.has(agentId)) {
        this.resume(agentId);
        startedLifetimes.add(agentId);
      }
    }
    for (const agentId of previous.keys()) {
      if (!nextIds.has(agentId)) this.storeProjection.remove(agentId, "scope");
    }
    this.members.clear();
    for (const agentId of nextIds) this.members.add(agentId);
    const agents = this.storeProjection.replaceFetched(reconciled);
    for (const agentId of startedLifetimes) this.acceptTimeline(agentId);
    for (const [agentId, previousAgent] of previous) {
      if (previousAgent.turn.phase === "open" && agents.get(agentId)?.turn.phase === "idle") {
        this.onStoppedRunning(agentId);
      }
    }
    if (persist) {
      this.persist([
        ...Array.from(previous.keys())
          .filter((agentId) => !agents.has(agentId))
          .map((id): DirectoryReplicaMutation => ({ kind: "agent", type: "delete", id })),
        ...Array.from(agents.values(), (value) => this.agentUpsert(value)),
      ]);
    }
    return agents;
  }

  commitChanges(
    entries: FetchAgentsEntry[],
    removals: readonly { id: string }[],
    deltas: readonly AgentDirectoryDelta[],
  ): Map<string, Agent> {
    const previous = this.storeProjection.snapshot();
    const merged = new Map<string, FetchAgentsEntry>();
    for (const agent of previous.values()) {
      const entry = projectAgentDirectoryEntry(agent);
      if (entry) merged.set(agent.id, entry);
    }
    for (const entry of entries) merged.set(entry.agent.id, entry);
    const removalsAsDeltas: AgentDirectoryDelta[] = removals.map(({ id }) => ({
      kind: "remove",
      agentId: id,
    }));
    const agents = this.commitSnapshot(
      Array.from(merged.values()),
      [...removalsAsDeltas, ...deltas],
      false,
    );
    const touchedIds = new Set([
      ...entries.map((entry) => entry.agent.id),
      ...removals.map(({ id }) => id),
      ...deltas.map((delta) => (delta.kind === "remove" ? delta.agentId : delta.agent.id)),
    ]);
    this.persist(
      Array.from(touchedIds, (id): DirectoryReplicaMutation => {
        const value = agents.get(id);
        return value ? this.agentUpsert(value) : { kind: "agent", type: "delete", id };
      }),
    );
    return agents;
  }

  archive(agentId: string, archivedAt: string): void {
    this.advance(agentId);
    const archived = this.storeProjection.archive(agentId, archivedAt);
    if (archived) this.persist([this.agentUpsert(archived)]);
    clearArchiveAgentPending({ queryClient, serverId: this.serverId, agentId });
  }

  remove(agentId: string): void {
    this.members.delete(agentId);
    this.advance(agentId);
    this.storeProjection.remove(agentId, "deleted");
    this.persist([{ kind: "agent", type: "delete", id: agentId }]);
  }

  applyTurnLiveness(
    agentId: string,
    transition: TurnLivenessTransition | readonly TurnLivenessTransition[],
  ): void {
    const wasRunning = this.storeProjection.get(agentId)?.turn.phase === "open";
    const accepted = this.storeProjection.applyTurn(agentId, transition);
    if (!accepted) return;
    this.persist([this.agentUpsert(accepted)]);
    if (wasRunning && accepted.turn.phase === "idle") this.onStoppedRunning(agentId);
  }

  private agentUpsert(agent: Agent): DirectoryReplicaMutation {
    return {
      kind: "agent",
      type: "upsert",
      id: agent.id,
      value: agent,
    };
  }

  private resume(agentId: string): void {
    // First admission keeps requests already in flight. Re-entry invalidates work issued
    // during the excluded lifetime as well as work issued before its removal.
    if (this.lifecycleVersions.has(agentId)) this.advance(agentId);
  }

  private advance(agentId: string): void {
    this.lifecycleVersions.set(agentId, (this.lifecycleVersions.get(agentId) ?? 0) + 1);
  }
}
