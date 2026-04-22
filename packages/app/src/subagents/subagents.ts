import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore, type Agent } from "@/stores/session-store";

export type SubagentRow = {
  id: Agent["id"];
  provider: Agent["provider"];
  title: Agent["title"];
  status: Agent["status"];
  requiresAttention: Agent["requiresAttention"];
  createdAt: Agent["createdAt"];
};

type SessionStoreSnapshot = ReturnType<typeof useSessionStore.getState>;

type SelectSubagentsParams = {
  serverId: string;
  parentAgentId: string;
};

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
): SubagentRow[] {
  const agents = state.sessions[params.serverId]?.agents;
  if (!agents || agents.size === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }

  const rows: SubagentRow[] = [];
  for (const agent of agents.values()) {
    if (agent.archivedAt || agent.parentAgentId !== params.parentAgentId) {
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

function areSubagentRowsEqual(left: SubagentRow[], right: SubagentRow[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftRow = left[index];
    const rightRow = right[index];
    if (
      !leftRow ||
      !rightRow ||
      leftRow.id !== rightRow.id ||
      leftRow.provider !== rightRow.provider ||
      leftRow.title !== rightRow.title ||
      leftRow.status !== rightRow.status ||
      leftRow.requiresAttention !== rightRow.requiresAttention ||
      leftRow.createdAt !== rightRow.createdAt
    ) {
      return false;
    }
  }
  return true;
}

export function useSubagentsForParent(params: SelectSubagentsParams): SubagentRow[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSubagentsForParent(state, params),
    areSubagentRowsEqual,
  );
}
