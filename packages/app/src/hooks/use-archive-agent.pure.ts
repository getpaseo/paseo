import type { QueryClient } from "@tanstack/react-query";
import { agentHistoryQueryKey } from "./agent-history-query-key";

export const ARCHIVE_AGENT_PENDING_QUERY_KEY = ["archive-agent-pending"] as const;
const EMPTY_PENDING_ARCHIVE_AGENT_IDS = new Set<string>();

export interface ArchiveAgentInput {
  serverId: string;
  agentId: string;
}

export type ArchiveAgentPendingState = Record<string, true>;

interface SetAgentArchivingInput extends ArchiveAgentInput {
  queryClient: QueryClient;
  isArchiving: boolean;
}

interface IsAgentArchivingInput extends ArchiveAgentInput {
  queryClient: QueryClient;
}

export interface AgentsListQueryData {
  entries?: Array<{ agent?: { id?: string | null } | null } | null>;
}

export interface AgentHistoryQueryAgent {
  id?: string | null;
  archivedAt?: Date | null;
}

export interface AgentHistoryQueryPage {
  agents?: AgentHistoryQueryAgent[];
}

export interface AgentHistoryQueryData {
  pages?: AgentHistoryQueryPage[];
}

export function toArchiveKey(input: ArchiveAgentInput): string {
  const serverId = input.serverId.trim();
  const agentId = input.agentId.trim();
  if (!serverId || !agentId) {
    return "";
  }
  return `${serverId}:${agentId}`;
}

export function readPendingState(queryClient: QueryClient): ArchiveAgentPendingState {
  return queryClient.getQueryData<ArchiveAgentPendingState>(ARCHIVE_AGENT_PENDING_QUERY_KEY) ?? {};
}

export function selectPendingArchiveAgentIds(
  pendingState: ArchiveAgentPendingState,
  serverId: string,
): ReadonlySet<string> {
  const normalizedServerId = serverId.trim();
  if (!normalizedServerId) {
    return EMPTY_PENDING_ARCHIVE_AGENT_IDS;
  }

  const prefix = `${normalizedServerId}:`;
  let agentIds: string[] | null = null;
  for (const key of Object.keys(pendingState)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const agentId = key.slice(prefix.length);
    if (!agentId) {
      continue;
    }
    agentIds ??= [];
    agentIds.push(agentId);
  }

  if (!agentIds || agentIds.length === 0) {
    return EMPTY_PENDING_ARCHIVE_AGENT_IDS;
  }
  return new Set(agentIds);
}

export function setAgentArchiving(input: SetAgentArchivingInput): void {
  const key = toArchiveKey(input);
  if (!key) {
    return;
  }

  input.queryClient.setQueryData<ArchiveAgentPendingState>(
    ARCHIVE_AGENT_PENDING_QUERY_KEY,
    (current) => {
      const state = current ?? {};
      if (input.isArchiving) {
        if (state[key]) {
          return state;
        }
        return { ...state, [key]: true };
      }

      if (!state[key]) {
        return state;
      }

      const next = { ...state };
      delete next[key];
      return next;
    },
  );
}

export function isAgentArchiving(input: IsAgentArchivingInput): boolean {
  const key = toArchiveKey(input);
  if (!key) {
    return false;
  }
  return readPendingState(input.queryClient)[key] ?? false;
}

export function removeAgentFromListPayload<T extends AgentsListQueryData | undefined>(
  payload: T,
  agentId: string,
): T {
  if (!payload || !Array.isArray(payload.entries) || !agentId) {
    return payload;
  }
  const filtered = payload.entries.filter((entry) => entry?.agent?.id !== agentId);
  if (filtered.length === payload.entries.length) {
    return payload;
  }
  return {
    ...payload,
    entries: filtered,
  } as T;
}

export function removeAgentFromCachedLists(
  queryClient: QueryClient,
  input: ArchiveAgentInput,
): void {
  const agentId = input.agentId.trim();
  if (!agentId) {
    return;
  }

  queryClient.setQueryData<AgentsListQueryData | undefined>(
    ["sidebarAgentsList", input.serverId],
    (current) => removeAgentFromListPayload(current, agentId),
  );
  queryClient.setQueryData<AgentsListQueryData | undefined>(
    ["allAgents", input.serverId],
    (current) => removeAgentFromListPayload(current, agentId),
  );
}

export function markAgentArchivedInHistoryPayload<T extends AgentHistoryQueryData | undefined>(
  payload: T,
  input: ArchiveAgentInput & { archivedAt: string },
): T {
  if (!payload || !Array.isArray(payload.pages) || !input.agentId) {
    return payload;
  }

  const archivedAt = new Date(input.archivedAt);
  if (Number.isNaN(archivedAt.getTime())) {
    return payload;
  }

  let changed = false;
  const pages = payload.pages.map((page) => {
    if (!Array.isArray(page.agents)) {
      return page;
    }

    let pageChanged = false;
    const agents = page.agents.map((agent) => {
      if (agent.id !== input.agentId) {
        return agent;
      }
      pageChanged = true;
      changed = true;
      return {
        ...agent,
        archivedAt,
      };
    });

    return pageChanged ? { ...page, agents } : page;
  });

  return changed ? ({ ...payload, pages } as T) : payload;
}

export function markAgentArchivedInHistoryCache(
  queryClient: QueryClient,
  input: ArchiveAgentInput & { archivedAt: string },
): void {
  queryClient.setQueryData<AgentHistoryQueryData | undefined>(
    agentHistoryQueryKey(input.serverId),
    (current) => markAgentArchivedInHistoryPayload(current, input),
  );
}

export function clearArchiveAgentPending(input: IsAgentArchivingInput): void {
  setAgentArchiving({
    ...input,
    isArchiving: false,
  });
}
