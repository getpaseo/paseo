import { supportsUsageReports } from "@getpaseo/client/internal/daemon-client";
import { useCallback, useMemo } from "react";
import { skipToken, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
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
  resolveUsageRefresh,
  resolveUsageView,
  type UsageHost,
  type UsageQueryState,
  type UsageRefresh,
} from "./model";
import type { UsageReportEntry, UsageView } from "./types";

// The daemon caches each report for five minutes, so re-reading it is cheap. Only
// an explicit refresh passes `forceRefresh` and reaches the source's API.
const REPORTS_STALE_TIME_MS = 60_000;

function usageReportsQueryKey(serverId: string) {
  return ["usage", "reports", serverId] as const;
}

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error(usageCopy.clientUnavailable);
  return client;
}

async function listReports(serverId: string, forceRefresh = false): Promise<UsageReportEntry[]> {
  return (await requireClient(serverId).listUsageReports({ forceRefresh })).reports;
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
  const query = useFetchQuery({
    queryKey: usageReportsQueryKey(serverId ?? ""),
    queryFn: serverId ? () => listReports(serverId) : skipToken,
    dataShape: "list",
    staleTimeMs: REPORTS_STALE_TIME_MS,
  });
  return query.data ?? NO_REPORTS;
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
