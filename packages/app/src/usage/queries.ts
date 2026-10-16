import { supportsUsageReports } from "@getpaseo/client/internal/daemon-client";
import { useCallback, useMemo } from "react";
import {
  skipToken,
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useShallow } from "zustand/shallow";
import { useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { usageCopy } from "./copy";
import {
  resolveAgentUsageView,
  resolveUsageRefresh,
  resolveUsageView,
  settleReports,
  type UsageHost,
  type UsageQueryState,
  type AgentUsageView,
  type UsageRefresh,
  upsertReport,
} from "./model";
import { agentUsageQueryKey, refreshReport, usageReportsQueryKey } from "./reports";
import type { UsageReportEntry, UsageView } from "./types";

// The daemon caches each report for five minutes, so re-reading it is cheap. Only
// an explicit refresh passes `forceRefresh` and reaches the source's API.
const REPORTS_STALE_TIME_MS = 60_000;

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error(usageCopy.clientUnavailable);
  return client;
}

/**
 * Lists a host's reports, or one agent's, writing each into `queryKey` as it streams in so a slow
 * source never holds back the others. The finished list then replaces the streamed one, dropping
 * any report the host no longer has, but never a report refreshed while the list streamed.
 */
async function streamReports(input: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  serverId: string;
  agentId?: string;
  forceRefresh?: boolean;
  /** Once aborted, reports still on their way are dropped instead of written. */
  signal?: AbortSignal;
}): Promise<UsageReportEntry[]> {
  const { queryClient, queryKey, serverId, agentId, forceRefresh = false, signal } = input;
  const { reports } = await requireClient(serverId).listUsageReports(
    { agentId, forceRefresh },
    (report) => {
      if (signal?.aborted) return;
      queryClient.setQueryData<UsageReportEntry[]>(queryKey, (current) =>
        upsertReport(current, report),
      );
    },
  );
  return settleReports(queryClient.getQueryData<UsageReportEntry[]>(queryKey), reports);
}

function listReports(
  queryClient: QueryClient,
  serverId: string,
  forceRefresh = false,
): Promise<UsageReportEntry[]> {
  return streamReports({
    queryClient,
    queryKey: usageReportsQueryKey(serverId),
    serverId,
    forceRefresh,
  });
}

function supportsUsage(session: SessionState | undefined): boolean {
  return supportsUsageReports(session?.serverInfo?.features);
}

async function refreshReports(queryClient: QueryClient, serverId: string): Promise<void> {
  await queryClient.fetchQuery({
    queryKey: usageReportsQueryKey(serverId),
    queryFn: () => listReports(queryClient, serverId, true),
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
    queryFn: () => listReports(queryClient, serverId),
    enabled: isConnected && isSupported,
    dataShape: "list",
    staleTimeMs: REPORTS_STALE_TIME_MS,
  });
  const refresh = useCallback(() => {
    void refreshReports(queryClient, serverId).catch(() => undefined);
  }, [queryClient, serverId]);
  const hostLabel = useHosts().find((host) => host.serverId === serverId)?.label ?? serverId;
  const view = resolveUsageView({
    hostLabel,
    isConnected,
    supportsUsage: isSupported,
    query: toQueryState(query),
  });
  return { view, refresh };
}

const NO_REPORTS: UsageReportEntry[] = [];

/**
 * The reports of the sidebar's usage host, which is connected and reports usage; none until they
 * load, or without a host.
 */
export function useUsageHostReports(serverId: string | null): UsageReportEntry[] {
  const queryClient = useQueryClient();
  const query = useFetchQuery({
    queryKey: usageReportsQueryKey(serverId ?? ""),
    queryFn: serverId ? () => listReports(queryClient, serverId) : skipToken,
    dataShape: "list",
    staleTimeMs: REPORTS_STALE_TIME_MS,
  });
  return query.data ?? NO_REPORTS;
}

/**
 * The reports of the account an agent runs under, as its meter's tooltip or sheet shows them.
 * Fetched while either is mounted, so only while it is open.
 */
export function useAgentUsage(serverId: string, agentId: string): AgentUsageView {
  const queryClient = useQueryClient();
  const canReport = useHostReportsUsage(serverId);
  const queryKey = agentUsageQueryKey(serverId, agentId);
  const query = useFetchQuery({
    queryKey,
    // Consuming the signal cancels the request when the details close, so a reopen sends a new
    // request instead of joining one scoped to the login the agent ran under before.
    queryFn: ({ signal }) => streamReports({ queryClient, queryKey, serverId, agentId, signal }),
    enabled: canReport,
    // Another agent's reports never stand in while this one's load.
    dataShape: "value",
    // Dropped as soon as the details close: an agent resumed under another login keeps its ID, so
    // reports kept from an earlier open could show the old login. The daemon's cache keeps each
    // open's request cheap.
    gcTime: 0,
    // The daemon's errors (an unknown agent) do not heal on retry, and reopening the details
    // fetches again; retrying would hold the loading sentence for seconds instead.
    retry: false,
    staleTimeMs: REPORTS_STALE_TIME_MS,
  });
  return resolveAgentUsageView({ canReport, query: toQueryState(query) });
}

/** Whether a host is connected and reports usage, read without fetching anything. */
export function useHostReportsUsage(serverId: string): boolean {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useSessionStore((state) => supportsUsage(state.sessions[serverId]));
  return isConnected && isSupported;
}

/** Every host with whether it is connected and reports usage, in host order. */
export function useUsageHosts(): UsageHost[] {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const supportedServerIds = useSessionStore(
    useShallow((state) => serverIds.filter((serverId) => supportsUsage(state.sessions[serverId]))),
  );
  return useMemo(
    () =>
      hosts.map((host) => ({
        serverId: host.serverId,
        label: host.label,
        isConnected: connectionStatuses.get(host.serverId) === "online",
        supportsUsage: supportedServerIds.includes(host.serverId),
      })),
    [connectionStatuses, hosts, supportedServerIds],
  );
}

/**
 * Refreshes a host report, or the agent's session reports. The result replaces the card
 * in the requesting view. Host and agent views can use different logins of the same account.
 */
export function useReportRefresh(
  serverId: string,
  reportId: string,
  agentId?: string,
): { refresh: () => void; refreshState: UsageRefresh } {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      refreshReport({
        client: requireClient(serverId),
        queryClient,
        serverId,
        reportId,
        agentId,
      }),
  });
  const { mutate } = mutation;
  const refresh = useCallback(() => mutate(), [mutate]);
  return { refresh, refreshState: resolveUsageRefresh(mutation) };
}
