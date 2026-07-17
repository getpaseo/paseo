import type { FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { clearArchiveAgentPending } from "@/hooks/use-archive-agent";
import { queryClient } from "@/data/query-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
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

export class AgentDirectoryReplica {
  private readonly lifecycleVersions = new Map<string, number>();
  private readonly members = new Set<string>();

  constructor(
    private readonly serverId: string,
    private readonly onStoppedRunning: (agentId: string) => void,
  ) {}

  captureTimeline(agentId: string): AgentLifecycleToken {
    return { agentId, version: this.lifecycleVersions.get(agentId) ?? 0 };
  }

  submitTimelineAgent(token: AgentLifecycleToken, payload: AgentSnapshotPayload): boolean {
    if (
      !this.members.has(token.agentId) ||
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
    for (const agentId of nextIds) this.members.add(agentId);
    const { agents } = replaceFetchedAgentDirectory({
      serverId: this.serverId,
      entries: reconciled.entries,
    });
    for (const agentId of reconciled.stoppedRunningAgentIds) this.onStoppedRunning(agentId);
    return agents;
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
