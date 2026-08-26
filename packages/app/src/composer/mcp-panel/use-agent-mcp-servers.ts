import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { i18n } from "@/i18n/i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { AgentMcpReport, AgentMcpServersView } from "./types";

/**
 * How long a fetched report stays good for on the client.
 *
 * MCP connections settle at agent startup and rarely move afterwards, and the fetch is
 * not uniformly cheap: Codex answers `mcpServerStatus/list` with every server's full
 * tool schemas, measured at 1.1 MB and ~3.5s, where Claude answers in 3ms. A window
 * this size makes closing and reopening the panel free; the refresh control stays
 * authoritative because it forces past both this cache and the daemon's.
 */
const STALE_TIME_MS = 60 * 1000;

export function agentMcpServersQueryKey(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
) {
  return ["agentMcpServers", serverId ?? "", agentId ?? ""] as const;
}

interface UseAgentMcpServersOptions {
  enabled?: boolean;
}

export function useAgentMcpServers(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
  options: UseAgentMcpServersOptions = {},
): {
  view: AgentMcpServersView;
  refresh: () => Promise<void>;
  canFetch: boolean;
} {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  // Undefined on daemons predating the panel, which is the same answer as a provider
  // that cannot report: no control, no request.
  const supportsMcpStatus = useSessionStore(
    (state) =>
      state.sessions[serverId ?? ""]?.agents?.get(agentId ?? "")?.capabilities
        ?.supportsMcpStatus === true,
  );
  const queryKey = useMemo(() => agentMcpServersQueryKey(serverId, agentId), [agentId, serverId]);
  const canFetch = Boolean(serverId && agentId && client && isConnected && supportsMcpStatus);
  const enabled = Boolean((options.enabled ?? true) && canFetch);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const load = useCallback(
    async (force: boolean): Promise<AgentMcpReport | "unsupported"> => {
      if (!client || !agentId) {
        throw new Error(i18n.t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.listMcpServers(agentId, force ? { force: true } : undefined);
      // Only `unsupported` is permanent, and only it may be cached as a verdict.
      // `agent_not_running` is the same agent between runtimes, so it is raised as an
      // error: retrying is exactly right, and caching it as terminal would delete the
      // control — and its refresh affordance — for the rest of the session.
      if (payload.unavailable === "unsupported") {
        return "unsupported";
      }
      if (payload.unavailable === "agent_not_running") {
        throw new Error(i18n.t("mcpServers.agentNotRunning"));
      }
      if (payload.error) {
        throw new Error(payload.error);
      }
      return { servers: payload.servers, source: payload.source ?? "live" };
    },
    [agentId, client],
  );

  const queryFn = useCallback(() => load(false), [load]);

  const query = useFetchQuery({
    queryKey,
    queryFn,
    enabled,
    // "value", not "list": `list` turns on keepPreviousData, which would show the
    // previous agent's servers under the new agent's name for the whole fetch.
    dataShape: "value",
    staleTimeMs: STALE_TIME_MS,
    // One request per attempt. The default three retries turn a failing Codex fetch into
    // four calls of 1.1 MB and ~3.5s each, and nothing here is worth ~14 seconds of
    // retrying when the panel has an explicit refresh control.
    retry: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const refresh = useCallback(async () => {
    if (!canFetch) return;
    setRefreshError(null);
    try {
      // Exactly one request. `fetchQuery` with a zero stale time already bypasses the
      // cache, so the `invalidateQueries` this used to do first was a second identical
      // fetch — two 3.5s Codex calls per press.
      const next = await queryClient.fetchQuery({
        queryKey,
        queryFn: () => load(true),
        staleTime: 0,
        retry: false,
      });
      queryClient.setQueryData(queryKey, next);
    } catch (error) {
      // A refetch over retained data leaves the query in a success state, so a failed
      // refresh is invisible unless it is held here.
      setRefreshError(error instanceof Error ? error.message : String(error));
    }
  }, [canFetch, load, queryClient, queryKey]);

  const view = useMemo<AgentMcpServersView>(() => {
    if (!supportsMcpStatus) {
      return { kind: "unsupported" };
    }
    // The capability said yes and the daemon said no. Trust the daemon: an agent
    // snapshot's capabilities can be a stale echo of a session that has since stopped.
    if (query.data === "unsupported") {
      return { kind: "unsupported" };
    }
    if (refreshError) {
      return { kind: "error", message: refreshError };
    }
    if (query.data) {
      return {
        kind: "ready",
        servers: query.data.servers,
        source: query.data.source,
        isRefreshing: query.isFetching,
      };
    }
    if (query.isError) {
      return {
        kind: "error",
        message: query.error instanceof Error ? query.error.message : String(query.error),
      };
    }
    return { kind: "loading" };
  }, [query.data, query.error, query.isError, query.isFetching, refreshError, supportsMcpStatus]);

  return { view, refresh, canFetch };
}
