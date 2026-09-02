import type { FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { clearArchiveAgentPending } from "@/hooks/use-archive-agent";
import { queryClient } from "@/data/query-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { normalizeAgentSnapshot, projectAgentSnapshot } from "@/utils/agent-snapshots";
import {
  applyAgentDirectoryDelta,
  type AgentDirectoryDelta,
  removeAgentDirectoryReplica,
  replaceAgentPendingPermissions,
  replaceFetchedAgentDirectory,
  upsertAgentReplica,
} from "@/utils/agent-directory-sync";
import { reconcileAgentDirectory } from "@/utils/agent-directory-reconciliation";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";

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

  constructor(
    private readonly serverId: string,
    private readonly onStoppedRunning: (agentId: string) => void,
  ) {}

  captureTimeline(agentId: string): AgentLifecycleToken {
    return { agentId, version: this.lifecycleVersions.get(agentId) ?? 0 };
  }

  captureCache(agentId: string): AgentLifecycleToken {
    this.pendingCacheReads.add(agentId);
    return this.captureTimeline(agentId);
  }

  commitCached(agents: Map<string, Agent>): void {
    this.members.clear();
    for (const [agentId, agent] of agents) {
      this.members.add(agentId);
      useSessionStore.getState().setAgentLastActivity(agentId, agent.lastActivityAt);
    }
    useSessionStore.getState().setAgents(this.serverId, agents);
  }

  commitCachedAgent(token: AgentLifecycleToken, agent: Agent): boolean {
    this.pendingCacheReads.delete(token.agentId);
    if (token.version !== (this.lifecycleVersions.get(token.agentId) ?? 0)) return false;
    if (this.members.has(agent.id)) return false;
    this.members.add(agent.id);
    useSessionStore.getState().setAgents(this.serverId, (current) => {
      if (current.has(agent.id)) return current;
      const next = new Map(current);
      next.set(agent.id, agent);
      return next;
    });
    useSessionStore.getState().setAgentLastActivity(agent.id, agent.lastActivityAt);
    return true;
  }

  submitTimelineAgent(token: AgentLifecycleToken, payload: AgentSnapshotPayload): boolean {
    if (token.version !== (this.lifecycleVersions.get(token.agentId) ?? 0)) {
      return false;
    }
    const existing = useSessionStore.getState().sessions[this.serverId]?.agents.get(token.agentId);
    const timelineAgent = applyLegacyDaemonWorkspaceOwnership({
      serverId: this.serverId,
      agent: normalizeAgentSnapshot(payload, this.serverId),
    });
    const normalized: Agent = {
      ...timelineAgent,
      projectPlacement: timelineAgent.projectPlacement ?? existing?.projectPlacement,
    };
    const accepted = upsertAgentReplica(this.serverId, normalized);
    this.members.add(accepted.id);
    replaceAgentPendingPermissions(this.serverId, accepted);
    useSessionStore.getState().setAgentLastActivity(accepted.id, accepted.lastActivityAt);
    if (accepted.archivedAt) {
      clearArchiveAgentPending({ queryClient, serverId: this.serverId, agentId: accepted.id });
    }
    return true;
  }

  applyDelta(delta: AgentDirectoryDelta): void {
    const before = this.members.has(delta.kind === "remove" ? delta.agentId : delta.agent.id);
    const result = applyAgentDirectoryDelta({ serverId: this.serverId, delta });
    if (delta.kind === "remove") {
      this.members.delete(delta.agentId);
      this.advance(delta.agentId);
    } else {
      this.members.add(delta.agent.id);
      if (!before) this.advance(delta.agent.id);
    }
    if (result.stoppedRunning) this.onStoppedRunning(result.agentId);
  }

  commitSnapshot(
    entries: FetchAgentsEntry[],
    deltas: readonly AgentDirectoryDelta[],
  ): Map<string, Agent> {
    const previous = useSessionStore.getState().sessions[this.serverId]?.agents ?? new Map();
    const reconciled = reconcileAgentDirectory({ previous, snapshot: entries, deltas });
    const nextIds = new Set(reconciled.entries.map((entry) => entry.agent.id));
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
      if (!nextIds.has(agentId)) removeAgentDirectoryReplica(this.serverId, agentId);
    }
    this.members.clear();
    this.pendingCacheReads.clear();
    for (const agentId of nextIds) this.members.add(agentId);
    const { agents } = replaceFetchedAgentDirectory({
      serverId: this.serverId,
      entries: reconciled.entries,
    });
    for (const agentId of reconciled.stoppedRunningAgentIds) this.onStoppedRunning(agentId);
    return agents;
  }

  commitChanges(
    entries: FetchAgentsEntry[],
    removals: readonly { id: string }[],
    deltas: readonly AgentDirectoryDelta[],
  ): Map<string, Agent> {
    const previous = useSessionStore.getState().sessions[this.serverId]?.agents ?? new Map();
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
    return this.commitSnapshot(Array.from(merged.values()), [...removalsAsDeltas, ...deltas]);
  }

  archive(agentId: string, archivedAt: string): void {
    this.advance(agentId);
    useSessionStore.getState().setAgents(this.serverId, (current) => {
      const agent = current.get(agentId);
      if (!agent) return current;
      const next = new Map(current);
      next.set(agentId, { ...agent, archivedAt: new Date(archivedAt) });
      return next;
    });
    clearArchiveAgentPending({ queryClient, serverId: this.serverId, agentId });
  }

  remove(agentId: string): void {
    this.members.delete(agentId);
    this.advance(agentId);
    removeAgentDirectoryReplica(this.serverId, agentId);
  }

  private advance(agentId: string): void {
    this.lifecycleVersions.set(agentId, (this.lifecycleVersions.get(agentId) ?? 0) + 1);
  }
}
