import type { FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import { type Agent, useSessionStore } from "@/stores/session-store";
import { derivePendingPermissionKey, normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { resolveProjectPlacement } from "@/utils/project-placement";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { clearArchiveAgentPending } from "@/hooks/use-archive-agent";
import { queryClient } from "@/data/query-client";
import { acceptAgentDirectoryUpdate } from "@/utils/agent-directory-update-policy";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { getInitDeferred, getInitKey, rejectInitDeferred } from "@/utils/agent-initialization";

type AgentDirectoryFetchEntry = FetchAgentsEntry;
export type AgentDirectoryDelta = Extract<
  SessionOutboundMessage,
  { type: "agent_update" }
>["payload"];

export function applyAgentDirectoryDelta(input: { serverId: string; delta: AgentDirectoryDelta }): {
  agentId: string;
  stoppedRunning: boolean;
} {
  if (input.delta.kind === "remove") {
    removeAgentDirectoryReplica(input.serverId, input.delta.agentId);
    return { agentId: input.delta.agentId, stoppedRunning: false };
  }
  return upsertAgentDirectoryReplica(input.serverId, input.delta);
}

type AgentUpsertDelta = Extract<AgentDirectoryDelta, { kind: "upsert" }>;

function upsertAgentDirectoryReplica(
  serverId: string,
  delta: AgentUpsertDelta,
): { agentId: string; stoppedRunning: boolean } {
  const normalized = normalizeAgentSnapshot(delta.agent, serverId);
  const session = useSessionStore.getState().sessions[serverId];
  const previousAgent =
    session?.agents.get(normalized.id) ?? session?.agentDetails.get(normalized.id);
  const legacyWorkspaceId =
    previousAgent?.workspaceId ??
    Array.from(session?.workspaces.values() ?? []).find(
      (workspace) =>
        session?.serverInfo?.features?.workspaceMultiplicity !== true &&
        workspace.workspaceDirectory === normalized.cwd,
    )?.id;
  const agent: Agent = {
    ...normalized,
    workspaceId: normalized.workspaceId ?? legacyWorkspaceId,
    projectPlacement:
      resolveProjectPlacement({ projectPlacement: delta.project, cwd: normalized.cwd }) ??
      previousAgent?.projectPlacement,
  };
  const acceptedAgent = upsertAgentReplica(serverId, agent);
  if (acceptedAgent.archivedAt) {
    clearArchiveAgentPending({ queryClient, serverId, agentId: acceptedAgent.id });
  }
  replaceAgentPendingPermissions(serverId, acceptedAgent);
  useSessionStore.getState().setAgentLastActivity(acceptedAgent.id, acceptedAgent.lastActivityAt);
  return {
    agentId: acceptedAgent.id,
    stoppedRunning: previousAgent?.status === "running" && acceptedAgent.status !== "running",
  };
}

export function upsertAgentReplica(serverId: string, agent: Agent): Agent {
  let acceptedAgent = agent;
  useSessionStore.getState().setAgents(serverId, (current) => {
    const currentAgent = current.get(agent.id);
    acceptedAgent = acceptAgentDirectoryUpdate(currentAgent, agent);
    if (acceptedAgent === currentAgent) return current;
    const next = new Map(current);
    next.set(agent.id, acceptedAgent);
    return next;
  });
  return acceptedAgent;
}

export function replaceAgentPendingPermissions(serverId: string, agent: Agent): void {
  const pendingPermissions = new Map(
    useSessionStore.getState().sessions[serverId]?.pendingPermissions,
  );
  for (const [key, pending] of pendingPermissions) {
    if (pending.agentId === agent.id) pendingPermissions.delete(key);
  }
  for (const request of agent.pendingPermissions) {
    const key = derivePendingPermissionKey(agent.id, request);
    pendingPermissions.set(key, { key, agentId: agent.id, request });
  }
  useSessionStore.getState().setPendingPermissions(serverId, pendingPermissions);
}

export function removeAgentDirectoryReplica(serverId: string, agentId: string): void {
  const store = useSessionStore.getState();
  clearArchiveAgentPending({ queryClient, serverId, agentId });
  const removeKey = <T>(current: Map<string, T>): Map<string, T> => {
    if (!current.has(agentId)) return current;
    const next = new Map(current);
    next.delete(agentId);
    return next;
  };
  store.setAgents(serverId, removeKey);
  store.setAgentDetails(serverId, removeKey);
  store.setQueuedMessages(serverId, removeKey);
  store.setAgentTimelineCursor(serverId, removeKey);
  store.setInitializingAgents(serverId, removeKey);
  store.setPendingPermissions(serverId, (current) => {
    const next = new Map(current);
    for (const [key, pending] of next) {
      if (pending.agentId === agentId) next.delete(key);
    }
    return next.size === current.size ? current : next;
  });
  store.setAgentAuthoritativeHistoryApplied(serverId, agentId, false);
  store.setAgentStreamTail(serverId, removeKey);
  store.clearAgentStreamHead(serverId, agentId);
  useSessionStore.setState((state) => {
    if (!state.agentLastActivity.has(agentId)) return state;
    const agentLastActivity = new Map(state.agentLastActivity);
    agentLastActivity.delete(agentId);
    return { ...state, agentLastActivity };
  });
  useDraftStore.getState().clearDraftInput({
    draftKey: buildDraftStoreKey({ serverId, agentId }),
  });
  const initKey = getInitKey(serverId, agentId);
  if (getInitDeferred(initKey)) {
    rejectInitDeferred(initKey, new Error("Agent was removed during initialization"));
  }
}

interface PendingPermissionEntry {
  key: string;
  agentId: string;
  request: Agent["pendingPermissions"][number];
}

export function buildAgentDirectoryState(input: {
  serverId: string;
  entries: AgentDirectoryFetchEntry[];
}): {
  agents: Map<string, Agent>;
  pendingPermissions: Map<string, PendingPermissionEntry>;
} {
  const agents = new Map<string, Agent>();
  const pendingPermissions = new Map<string, PendingPermissionEntry>();

  for (const entry of input.entries) {
    const normalized = normalizeAgentSnapshot(entry.agent, input.serverId);
    const projectPlacement = resolveProjectPlacement({
      projectPlacement: entry.project,
      cwd: normalized.cwd,
    });
    const agent: Agent = {
      ...normalized,
      projectPlacement,
    };
    agents.set(agent.id, agent);

    for (const request of agent.pendingPermissions) {
      const key = derivePendingPermissionKey(agent.id, request);
      pendingPermissions.set(key, { key, agentId: agent.id, request });
    }
  }

  return { agents, pendingPermissions };
}

export function replaceFetchedAgentDirectory(input: {
  serverId: string;
  entries: FetchAgentsEntry[];
}): { agents: Map<string, Agent> } {
  const { agents: fetchedAgents, pendingPermissions } = buildAgentDirectoryState(input);
  const store = useSessionStore.getState();

  for (const agent of fetchedAgents.values()) {
    if (agent.archivedAt) {
      clearArchiveAgentPending({ queryClient, serverId: input.serverId, agentId: agent.id });
    }
  }

  store.setAgents(input.serverId, fetchedAgents);
  store.setAgentDetails(input.serverId, (prev) => {
    let next: Map<string, Agent> | null = null;
    for (const agentId of fetchedAgents.keys()) {
      if (!prev.has(agentId)) {
        continue;
      }
      next ??= new Map(prev);
      next.delete(agentId);
    }
    return next ?? prev;
  });

  const lastActivityByAgentId = new Map<string, Date>();
  for (const agent of fetchedAgents.values()) {
    lastActivityByAgentId.set(agent.id, agent.lastActivityAt);
  }
  store.setAgentLastActivityBatch(lastActivityByAgentId);

  store.setPendingPermissions(input.serverId, new Map(pendingPermissions));
  store.setHasHydratedAgents(input.serverId, true);
  return { agents: fetchedAgents };
}
