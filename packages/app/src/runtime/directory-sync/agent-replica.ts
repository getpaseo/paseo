import type { FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { clearArchiveAgentPending } from "@/hooks/use-archive-agent";
import { queryClient } from "@/data/query-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { acceptAgentDirectoryUpdate } from "@/utils/agent-directory-update-policy";
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

export interface AgentLifecycleToken {
  readonly agentId: string;
  readonly version: number;
}

interface AuthoritativeAgentState {
  status: AgentSnapshotPayload["status"];
  updatedAt: Date | string;
  lastUsage?: AgentSnapshotPayload["lastUsage"];
  archivedAt?: Date | string | null;
}

export class AgentDirectoryReplica {
  private readonly lifecycleVersions = new Map<string, number>();
  private readonly authoritativeAgents = new Map<string, AuthoritativeAgentState>();

  constructor(
    private readonly serverId: string,
    private readonly onStoppedRunning: (agentId: string) => void,
  ) {
    const existing = useSessionStore.getState().sessions[serverId]?.agents ?? new Map();
    for (const [agentId, agent] of existing) this.authoritativeAgents.set(agentId, agent);
  }

  captureTimeline(agentId: string): AgentLifecycleToken {
    return { agentId, version: this.lifecycleVersions.get(agentId) ?? 0 };
  }

  submitTimelineAgent(token: AgentLifecycleToken, payload: AgentSnapshotPayload): boolean {
    if (
      !this.authoritativeAgents.has(token.agentId) ||
      token.version !== (this.lifecycleVersions.get(token.agentId) ?? 0)
    ) {
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
    replaceAgentPendingPermissions(this.serverId, accepted);
    useSessionStore.getState().setAgentLastActivity(accepted.id, accepted.lastActivityAt);
    if (accepted.archivedAt) {
      clearArchiveAgentPending({ queryClient, serverId: this.serverId, agentId: accepted.id });
    }
    return true;
  }

  applyDelta(delta: AgentDirectoryDelta): void {
    if (delta.kind === "remove") {
      applyAgentDirectoryDelta({ serverId: this.serverId, delta });
      this.authoritativeAgents.delete(delta.agentId);
      this.advance(delta.agentId);
      return;
    }

    const previous = this.authoritativeAgents.get(delta.agent.id);
    const accepted = acceptAgentDirectoryUpdate(previous, delta.agent);
    applyAgentDirectoryDelta({ serverId: this.serverId, delta });
    this.authoritativeAgents.set(delta.agent.id, accepted);
    if (!previous) this.advance(delta.agent.id);
    if (previous?.status === "running" && accepted.status !== "running" && !accepted.archivedAt) {
      this.onStoppedRunning(delta.agent.id);
    }
  }

  commitSnapshot(
    entries: FetchAgentsEntry[],
    deltas: readonly AgentDirectoryDelta[],
  ): Map<string, Agent> {
    const previous = this.authoritativeAgents;
    const reconciled = reconcileAgentDirectory({ previous, snapshot: entries, deltas });
    const nextIds = new Set(reconciled.entries.map((entry) => entry.agent.id));
    for (const agentId of this.authoritativeAgents.keys()) {
      if (!nextIds.has(agentId)) this.advance(agentId);
    }
    for (const agentId of nextIds) {
      if (!this.authoritativeAgents.has(agentId)) this.advance(agentId);
    }
    const replicaAgents = useSessionStore.getState().sessions[this.serverId]?.agents ?? new Map();
    for (const agentId of replicaAgents.keys()) {
      if (!nextIds.has(agentId)) removeAgentDirectoryReplica(this.serverId, agentId);
    }
    this.authoritativeAgents.clear();
    for (const { agent } of reconciled.entries) this.authoritativeAgents.set(agent.id, agent);
    const { agents } = replaceFetchedAgentDirectory({
      serverId: this.serverId,
      entries: reconciled.entries,
    });
    for (const agentId of reconciled.stoppedRunningAgentIds) {
      if (!this.authoritativeAgents.get(agentId)?.archivedAt) this.onStoppedRunning(agentId);
    }
    return agents;
  }

  archive(agentId: string, archivedAt: string): void {
    this.advance(agentId);
    const authoritative = this.authoritativeAgents.get(agentId);
    if (authoritative) {
      this.authoritativeAgents.set(agentId, { ...authoritative, archivedAt });
    }
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
    this.authoritativeAgents.delete(agentId);
    this.advance(agentId);
    removeAgentDirectoryReplica(this.serverId, agentId);
  }

  private advance(agentId: string): void {
    this.lifecycleVersions.set(agentId, (this.lifecycleVersions.get(agentId) ?? 0) + 1);
  }
}
