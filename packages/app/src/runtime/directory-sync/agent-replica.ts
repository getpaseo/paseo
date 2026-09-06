import type { FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { clearArchiveAgentPending } from "@/hooks/use-archive-agent";
import { queryClient } from "@/data/query-client";
import type { Agent } from "@/stores/session-store";
import { normalizeAgentSnapshot, projectAgentSnapshot } from "@/utils/agent-snapshots";
import { type AgentDirectoryDelta } from "@/utils/agent-directory-sync";
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
  private readonly pendingCacheReads = new Set<string>();
  private readonly storeProjection: AgentStoreProjection;

  constructor(
    private readonly serverId: string,
    private readonly onStoppedRunning: (agentId: string) => void,
    private readonly persist: (mutations: readonly DirectoryReplicaMutation[]) => void,
  ) {
    this.storeProjection = new AgentStoreProjection(serverId);
  }

  captureTimeline(agentId: string): AgentLifecycleToken {
    return { agentId, version: this.lifecycleVersions.get(agentId) ?? 0 };
  }

  snapshot(): Map<string, Agent> {
    return this.storeProjection.snapshot();
  }

  captureCache(agentId: string): AgentLifecycleToken {
    this.pendingCacheReads.add(agentId);
    return this.captureTimeline(agentId);
  }

  commitCached(agents: Map<string, Agent>): void {
    const merged = this.storeProjection.commitCached(agents);
    this.members.clear();
    for (const agentId of merged.keys()) {
      this.members.add(agentId);
    }
  }

  commitCachedAgent(token: AgentLifecycleToken, agent: Agent): boolean {
    this.pendingCacheReads.delete(token.agentId);
    if (token.version !== (this.lifecycleVersions.get(token.agentId) ?? 0)) return false;
    if (this.members.has(agent.id)) return false;
    this.members.add(agent.id);
    this.storeProjection.accept(agent);
    this.storeProjection.publishActivity(agent);
    return true;
  }

  submitTimelineAgent(token: AgentLifecycleToken, payload: AgentSnapshotPayload): boolean {
    if (token.version !== (this.lifecycleVersions.get(token.agentId) ?? 0)) {
      return false;
    }
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
      if (!before) this.advance(delta.agent.id);
    }
    if (result.stoppedRunning) this.onStoppedRunning(result.agentId);
    this.persist(
      result.agent
        ? [this.agentUpsert(result.agent)]
        : [{ kind: "agent", type: "delete", id: result.agentId }],
    );
  }

  accept(agent: Agent): Agent {
    const accepted = this.storeProjection.accept(agent);
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
    for (const agentId of this.pendingCacheReads) {
      if (!nextIds.has(agentId)) this.advance(agentId);
    }
    for (const agentId of this.members) {
      if (!nextIds.has(agentId)) this.advance(agentId);
    }
    for (const agentId of nextIds) {
      if (!this.members.has(agentId)) this.advance(agentId);
    }
    for (const agentId of previous.keys()) {
      if (!nextIds.has(agentId)) this.storeProjection.remove(agentId);
    }
    this.members.clear();
    this.pendingCacheReads.clear();
    for (const agentId of nextIds) this.members.add(agentId);
    const agents = this.storeProjection.replaceFetched(reconciled);
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
    this.storeProjection.remove(agentId);
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

  private advance(agentId: string): void {
    this.lifecycleVersions.set(agentId, (this.lifecycleVersions.get(agentId) ?? 0) + 1);
  }
}
