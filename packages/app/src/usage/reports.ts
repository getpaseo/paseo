import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { QueryClient } from "@tanstack/react-query";
import { replaceReport, settleReports } from "./model";
import type { UsageReportEntry } from "./types";

function hostUsageQueryKey(serverId: string) {
  return ["usage", serverId] as const;
}

export function usageReportsQueryKey(serverId: string) {
  return [...hostUsageQueryKey(serverId), "reports"] as const;
}

export function agentUsageQueryKey(serverId: string, agentId: string) {
  return [...hostUsageQueryKey(serverId), "agent", agentId] as const;
}

interface RefreshReportInput {
  client: Pick<DaemonClient, "listUsageReports">;
  queryClient: QueryClient;
  serverId: string;
  reportId: string;
  agentId?: string;
}

export async function refreshReport({
  client,
  queryClient,
  serverId,
  reportId,
  agentId,
}: RefreshReportInput): Promise<void> {
  const options =
    agentId === undefined
      ? { reportIds: [reportId], forceRefresh: true }
      : { agentId, forceRefresh: true };
  const { reports: refreshed } = await client.listUsageReports(options);
  const queryKey =
    agentId === undefined ? usageReportsQueryKey(serverId) : agentUsageQueryKey(serverId, agentId);
  queryClient.setQueryData<UsageReportEntry[]>(queryKey, (reports) => {
    if (agentId !== undefined) return settleReports(reports, refreshed);
    const report = refreshed.find((entry) => entry.id === reportId) ?? null;
    return reports ? replaceReport(reports, reportId, report) : reports;
  });
  if (!refreshed.some((entry) => entry.id === reportId)) {
    void queryClient.invalidateQueries({
      queryKey: usageReportsQueryKey(serverId),
      exact: true,
    });
  }
}
