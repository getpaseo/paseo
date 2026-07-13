import type {
  DaemonClient,
  FetchAgentHistoryPageInfo,
} from "@getpaseo/client/internal/daemon-client";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { HistorySortMode } from "@/stores/history-view-store";
import { buildAgentDirectoryState } from "@/utils/agent-directory-sync";
import {
  compareHistoryAgents,
  DEFAULT_AGENT_HISTORY_QUERY,
  type HistoryServerQuery,
} from "./history-view-model";

const AGENT_HISTORY_PAGE_LIMIT = 200;
const AGENT_HISTORY_ALL_HOSTS_FAILED_MESSAGE = "No connected hosts could load agent history";

export interface AgentHistoryPage {
  agents: AggregatedAgent[];
  pageInfo: FetchAgentHistoryPageInfo;
}

export type AgentHistoryClient = Pick<DaemonClient, "fetchAgentHistory">;

export interface AgentHistoryHost {
  serverId: string;
  serverLabel: string;
  client: AgentHistoryClient;
  supportsPinning?: boolean;
}

export interface AgentHistoryBatchPage {
  agents: AggregatedAgent[];
  pageInfoByServerId: Record<string, FetchAgentHistoryPageInfo>;
}

export type AgentHistoryCursorByServerId = Record<string, string | null>;

export async function fetchAgentHistoryPage(input: {
  client: AgentHistoryClient;
  serverId: string;
  cursor: string | null;
  query?: HistoryServerQuery;
  supportsPinning?: boolean;
}): Promise<AgentHistoryPage> {
  const query = input.query ?? DEFAULT_AGENT_HISTORY_QUERY;
  const sort =
    input.supportsPinning === false
      ? query.sort.filter((entry) => entry.key !== "pinned")
      : query.sort;
  const payload = await input.client.fetchAgentHistory({
    filter: query.filter,
    sort,
    page: input.cursor
      ? { limit: AGENT_HISTORY_PAGE_LIMIT, cursor: input.cursor }
      : { limit: AGENT_HISTORY_PAGE_LIMIT },
  });

  const { agents } = buildAgentDirectoryState({
    serverId: input.serverId,
    entries: payload.entries,
  });

  return {
    agents: Array.from(agents.values(), (agent) => ({
      id: agent.id,
      serverId: input.serverId,
      serverLabel: input.serverId,
      title: agent.title ?? null,
      status: agent.status,
      lastActivityAt: agent.lastActivityAt,
      cwd: agent.cwd,
      workspaceId: agent.workspaceId,
      provider: agent.provider,
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
      attentionTimestamp: agent.attentionTimestamp ?? null,
      archivedAt: agent.archivedAt ?? null,
      createdAt: agent.createdAt,
      pinnedAt: agent.pinnedAt ?? null,
      labels: agent.labels,
      projectPlacement: agent.projectPlacement,
    })),
    pageInfo: payload.pageInfo,
  };
}

export function getNextAgentHistoryPageParam(
  page: AgentHistoryBatchPage,
): AgentHistoryCursorByServerId | null {
  const cursorByServerId: AgentHistoryCursorByServerId = {};
  for (const [serverId, pageInfo] of Object.entries(page.pageInfoByServerId)) {
    if (pageInfo.hasMore && pageInfo.nextCursor) {
      cursorByServerId[serverId] = pageInfo.nextCursor;
    }
  }
  return Object.keys(cursorByServerId).length > 0 ? cursorByServerId : null;
}

export async function fetchAgentHistoryBatch(input: {
  hosts: readonly AgentHistoryHost[];
  cursorByServerId: AgentHistoryCursorByServerId | null;
  query?: HistoryServerQuery;
  sortMode?: HistorySortMode;
}): Promise<AgentHistoryBatchPage> {
  const query = input.query ?? DEFAULT_AGENT_HISTORY_QUERY;
  const sortMode = input.sortMode ?? "recency";
  const cursorByServerId = input.cursorByServerId ?? {};
  const hasCursorFilter = Object.keys(cursorByServerId).length > 0;
  const hostsToFetch = hasCursorFilter
    ? input.hosts.filter((host) => Object.hasOwn(cursorByServerId, host.serverId))
    : input.hosts;

  const settledPages = await Promise.allSettled(
    hostsToFetch.map(async (host) => {
      const page = await fetchAgentHistoryPage({
        client: host.client,
        serverId: host.serverId,
        cursor: cursorByServerId[host.serverId] ?? null,
        query,
        supportsPinning: host.supportsPinning,
      });
      return { host, page };
    }),
  );
  const pages = settledPages.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (pages.length === 0) {
    throw new Error(AGENT_HISTORY_ALL_HOSTS_FAILED_MESSAGE);
  }

  const agents = pages.flatMap(({ host, page }) =>
    page.agents.map((agent) => Object.assign({}, agent, { serverLabel: host.serverLabel })),
  );
  const pageInfoByServerId = Object.fromEntries(
    pages.map(({ host, page }) => [host.serverId, page.pageInfo]),
  );

  return {
    agents: agents.sort((left, right) => compareHistoryAgents(left, right, sortMode)),
    pageInfoByServerId,
  };
}
