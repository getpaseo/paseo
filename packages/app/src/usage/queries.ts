import { useCallback, useMemo } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/shallow";
import { useFetchQueries, useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { usageCopy } from "./copy";
import {
  groupUsageByHost,
  resolveUsagePill,
  resolveUsageView,
  type UsageHostGroup,
  type UsagePill,
  type UsageQueryState,
} from "./model";
import type { UsageReportEntry, UsageView } from "./types";

// The daemon caches each report for five minutes, so re-reading it is cheap. Only
// an explicit refresh passes `forceRefresh` and reaches the source's API.
const REPORTS_STALE_TIME_MS = 60_000;

function usageReportsQueryKey(serverId: string) {
  return ["usage", "reports", serverId] as const;
}

function agentUsageQueryKey(serverId: string, agentId: string, model: string | null) {
  return ["usage", "agent", serverId, agentId, model] as const;
}

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error(usageCopy.clientUnavailable);
  return client;
}

async function listReports(serverId: string, forceRefresh = false): Promise<UsageReportEntry[]> {
  return (await requireClient(serverId).listUsageReports({ forceRefresh })).reports;
}

async function getAgentReport(
  serverId: string,
  agentId: string,
  forceRefresh = false,
): Promise<UsageReportEntry | null> {
  return (await requireClient(serverId).getAgentUsageReport({ agentId, forceRefresh })).entry;
}

function supportsUsage(session: SessionState | undefined): boolean {
  return session?.serverInfo?.features?.usageSources === true;
}

async function refreshReports(queryClient: QueryClient, serverId: string): Promise<void> {
  await queryClient.fetchQuery({
    queryKey: usageReportsQueryKey(serverId),
    queryFn: () => listReports(serverId, true),
    staleTime: 0,
  });
}

function toQueryState(query: {
  data: UsageReportEntry[] | undefined;
  error: unknown;
  isFetching: boolean;
}): UsageQueryState {
  return { data: query.data, error: query.error, isFetching: query.isFetching };
}

/** Usage reports for one host, as shown on its settings page. */
export function useHostUsage(serverId: string): { view: UsageView; refresh: () => void } {
  const queryClient = useQueryClient();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useSessionStore((state) => supportsUsage(state.sessions[serverId]));
  const query = useFetchQuery({
    queryKey: usageReportsQueryKey(serverId),
    queryFn: () => listReports(serverId),
    enabled: isConnected && isSupported,
    dataShape: "list",
    staleTimeMs: REPORTS_STALE_TIME_MS,
  });
  const refresh = useCallback(() => {
    void refreshReports(queryClient, serverId).catch(() => undefined);
  }, [queryClient, serverId]);
  const view = resolveUsageView({
    isConnected,
    supportsUsage: isSupported,
    query: toQueryState(query),
  });
  return { view, refresh };
}

/** Usage reports for every connected host, grouped by host. */
export function useUsageByHost(): {
  groups: UsageHostGroup[];
  refresh: (serverId: string) => void;
} {
  const queryClient = useQueryClient();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const supportedServerIds = useSessionStore(
    useShallow((state) => serverIds.filter((serverId) => supportsUsage(state.sessions[serverId]))),
  );
  const usageHosts = useMemo(
    () =>
      hosts.map((host) => ({
        serverId: host.serverId,
        label: host.label,
        isConnected: connectionStatuses.get(host.serverId) === "online",
        supportsUsage: supportedServerIds.includes(host.serverId),
      })),
    [connectionStatuses, hosts, supportedServerIds],
  );
  const results = useFetchQueries<UsageReportEntry[]>(
    usageHosts.map((host) => ({
      queryKey: usageReportsQueryKey(host.serverId),
      queryFn: () => listReports(host.serverId),
      enabled: host.isConnected && host.supportsUsage,
      dataShape: "list",
      staleTimeMs: REPORTS_STALE_TIME_MS,
    })),
  );
  const groups = groupUsageByHost(
    usageHosts,
    new Map(usageHosts.map((host, index) => [host.serverId, toQueryState(results[index])])),
  );
  const refresh = useCallback(
    (serverId: string) => {
      void refreshReports(queryClient, serverId).catch(() => undefined);
    },
    [queryClient],
  );
  return { groups, refresh };
}

/**
 * The usage report for the account an agent is spending. The daemon resolves the
 * account at fetch time, so the query refetches when the model changes (a new key)
 * and when a turn completes (the query is paused while the agent runs, and its
 * data is always stale, so resuming refetches).
 */
export function useAgentUsage(
  serverId: string,
  agentId: string,
): { pill: UsagePill | null; entry: UsageReportEntry | null; refresh: () => void } {
  const queryClient = useQueryClient();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useSessionStore((state) => supportsUsage(state.sessions[serverId]));
  const { model, isRunning } = useSessionStore(
    useShallow((state) => {
      const agent = state.sessions[serverId]?.agents?.get(agentId);
      return { model: agent?.model ?? null, isRunning: agent?.status === "running" };
    }),
  );
  const queryKey = agentUsageQueryKey(serverId, agentId, model);
  const query = useFetchQuery({
    queryKey,
    queryFn: () => getAgentReport(serverId, agentId),
    enabled: isConnected && isSupported && !isRunning,
    dataShape: "value",
    staleTimeMs: 0,
  });
  const refresh = useCallback(() => {
    void queryClient
      .fetchQuery({
        queryKey: agentUsageQueryKey(serverId, agentId, model),
        queryFn: () => getAgentReport(serverId, agentId, true),
        staleTime: 0,
      })
      .catch(() => undefined);
  }, [agentId, model, queryClient, serverId]);
  const entry = isSupported ? (query.data ?? null) : null;
  return { pill: resolveUsagePill({ supportsUsage: isSupported, entry }), entry, refresh };
}
