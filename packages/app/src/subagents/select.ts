import { usePendingArchiveAgentIds } from "@/hooks/use-archive-agent";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { AgentSubsessionPayload } from "@getpaseo/protocol/messages";
import { useSessionStore, type Agent } from "@/stores/session-store";

export interface SubagentRow {
  id: Agent["id"];
  provider: Agent["provider"];
  title: Agent["title"];
  status: Agent["status"];
  requiresAttention: Agent["requiresAttention"];
  createdAt: Agent["createdAt"];
}

type SessionStoreSnapshot = ReturnType<typeof useSessionStore.getState>;

interface SelectSubagentsParams {
  serverId: string;
  parentAgentId: string;
}

const EMPTY_SUBAGENT_ROWS: SubagentRow[] = [];

function toSubagentRow(agent: Agent): SubagentRow {
  return {
    id: agent.id,
    provider: agent.provider,
    title: agent.title,
    status: agent.status,
    requiresAttention: agent.requiresAttention,
    createdAt: agent.createdAt,
  };
}

export function selectSubagentsForParent(
  state: SessionStoreSnapshot,
  params: SelectSubagentsParams,
  pendingArchiveIds: ReadonlySet<string>,
): SubagentRow[] {
  const agents = state.sessions[params.serverId]?.agents;
  if (!agents || agents.size === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }

  const rows: SubagentRow[] = [];
  for (const agent of agents.values()) {
    if (
      agent.archivedAt ||
      pendingArchiveIds.has(agent.id) ||
      agent.parentAgentId !== params.parentAgentId
    ) {
      continue;
    }
    rows.push(toSubagentRow(agent));
  }

  if (rows.length === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }

  rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return rows;
}

export function useSubagentsForParent(params: SelectSubagentsParams): SubagentRow[] {
  const pendingArchiveIds = usePendingArchiveAgentIds(params.serverId);
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSubagentsForParent(state, params, pendingArchiveIds),
    equal,
  );
}

const EMPTY_SUBSESSIONS: AgentSubsessionPayload[] = [];

interface SelectSubsessionsParams {
  serverId: string;
  agentId: string;
}

export function selectSubsessionsForAgent(
  state: SessionStoreSnapshot,
  params: SelectSubsessionsParams,
): AgentSubsessionPayload[] {
  const session = state.sessions[params.serverId];
  const agent = session?.agents.get(params.agentId) ?? session?.agentDetails.get(params.agentId);
  const subsessions = agent?.subsessions;
  return subsessions && subsessions.length > 0 ? subsessions : EMPTY_SUBSESSIONS;
}

export function useSubsessionsForAgent(params: SelectSubsessionsParams): AgentSubsessionPayload[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSubsessionsForAgent(state, params),
    equal,
  );
}

export interface WorkspaceSubsessionAgent {
  agentId: string;
  subsessions: AgentSubsessionPayload[];
}

const EMPTY_WORKSPACE_SUBSESSION_AGENTS: WorkspaceSubsessionAgent[] = [];

interface SelectWorkspaceSubsessionsParams {
  serverId: string;
  workspaceId: string;
}

export function selectWorkspaceSubsessionAgents(
  state: SessionStoreSnapshot,
  params: SelectWorkspaceSubsessionsParams,
): WorkspaceSubsessionAgent[] {
  const session = state.sessions[params.serverId];
  if (!session || session.agents.size === 0) {
    return EMPTY_WORKSPACE_SUBSESSION_AGENTS;
  }

  const entries: { createdAtMs: number; entry: WorkspaceSubsessionAgent }[] = [];
  for (const agent of session.agents.values()) {
    if (agent.archivedAt || agent.workspaceId !== params.workspaceId) {
      continue;
    }
    if (!agent.subsessions || agent.subsessions.length === 0) {
      continue;
    }
    entries.push({
      createdAtMs: agent.createdAt.getTime(),
      entry: { agentId: agent.id, subsessions: agent.subsessions },
    });
  }

  if (entries.length === 0) {
    return EMPTY_WORKSPACE_SUBSESSION_AGENTS;
  }

  entries.sort((left, right) => left.createdAtMs - right.createdAtMs);
  return entries.map(({ entry }) => entry);
}

export function useWorkspaceSubsessionAgents(
  params: SelectWorkspaceSubsessionsParams,
): WorkspaceSubsessionAgent[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceSubsessionAgents(state, params),
    equal,
  );
}
