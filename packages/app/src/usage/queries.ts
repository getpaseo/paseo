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
  replaceReport,
  resolveAgentUsageView,
  resolveUsageRefresh,
  resolveUsageView,
  type UsageHost,
  type UsageQueryState,
  type AgentUsageView,
  type UsageRefresh,
  upsertReport,
} from "./model";
import type { UsageReportEntry, UsageView } from "./types";

// The daemon caches each report for five minutes, so re-reading it is cheap. Only
// an explicit refresh passes `forceRefresh` and reaches the source's API.
const REPORTS_STALE_TIME_MS = 60_000;

function usageReportsQueryKey(serverId: string) {
  return ["usage", "reports", serverId] as const;
}

function agentUsageQueryKey(serverId: string, agentId: string) {
  return ["usage", "agent", serverId, agentId] as const;
}

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error(usageCopy.clientUnavailable);
  return client;
}

/**
 * Lists a host's reports, or one agent's, writing each into `queryKey` as it streams in so a slow
 * source never holds back the others. The finished list then replaces the streamed one, dropping
 * any report the host no longer has.
 */
async function streamReports(input: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  serverId: string;
  agentId?: string;
  forceRefresh?: boolean;
}): Promise<UsageReportEntry[]> {
  const { queryClient, queryKey, serverId, agentId, forceRefresh = false } = input;
  const { reports } = await requireClient(serverId).listUsageReports(
    { agentId, forceRefresh },
    (report) => {
      queryClient.setQueryData<UsageReportEntry[]>(queryKey, (current) =>
        upsertReport(current, report),
      );
    },
  );
  return reports;
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

async function getReport(
  serverId: string,
  reportId: string,
  forceRefresh = false,
): Promise<UsageReportEntry | null> {
  return (
    (await requireClient(serverId).listUsageReports({ reportIds: [reportId], forceRefresh }))
      .reports[0] ?? null
  );
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
 * The reports of the account an agent runs under, as its meter popover shows them. Fetched while
 * the popover is mounted, so only while it is open.
 */
export function useAgentUsage(serverId: string, agentId: string): AgentUsageView {
  const queryClient = useQueryClient();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useSessionStore((state) => supportsUsage(state.sessions[serverId]));
  const queryKey = agentUsageQueryKey(serverId, agentId);
  const query = useFetchQuery({
    queryKey,
    queryFn: () => streamReports({ queryClient, queryKey, serverId, agentId }),
    enabled: isConnected && isSupported,
    // Another agent's reports never stand in while this one's load.
    dataShape: "value",
    // The daemon's errors (an unknown agent) do not heal on retry, and reopening the popover
    // fetches again; retrying would hold the loading sentence for seconds instead.
    retry: false,
    staleTimeMs: REPORTS_STALE_TIME_MS,
  });
  return resolveAgentUsageView({
    canReport: isConnected && isSupported,
    query: toQueryState(query),
  });
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
 * Forces the source to fetch one report, and only that report. The result replaces the report
 * in its host's list, so every surface showing it moves together; until then the previous report
 * stays on screen.
 */
export function useReportRefresh(
  serverId: string,
  reportId: string,
): { refresh: () => void; refreshState: UsageRefresh } {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => getReport(serverId, reportId, true),
    onSuccess: (report) => {
      queryClient.setQueryData<UsageReportEntry[]>(usageReportsQueryKey(serverId), (reports) =>
        reports ? replaceReport(reports, reportId, report) : reports,
      );
    },
  });
  const { mutate } = mutation;
  const refresh = useCallback(() => mutate(), [mutate]);
  return { refresh, refreshState: resolveUsageRefresh(mutation) };
}
