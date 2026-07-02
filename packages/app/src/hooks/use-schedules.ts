import { useMemo, useSyncExternalStore } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import {
  fetchAggregatedSchedules,
  type AggregatedSchedule,
  type ScheduleHostError,
  type ScheduleHostInput,
} from "@/schedules/aggregated-schedules";

export type { AggregatedSchedule, ScheduleHostError } from "@/schedules/aggregated-schedules";

export const schedulesQueryBaseKey = ["schedules"] as const;

// Cache identity for the host set. The query also carries the runtime version
// (below) so it retries as connectivity changes and reliably fetches once a host
// comes online — even on a cold deep-link. The full-screen spinner flash that
// keying on the version used to cause is prevented by keepPreviousData plus the
// isInitialLoad(data === undefined) gate, not by dropping the version.
export function schedulesQueryKey(serverIds: readonly string[]) {
  return [...schedulesQueryBaseKey, [...serverIds].sort().join("|")] as const;
}

export interface UseSchedulesResult {
  schedules: AggregatedSchedule[];
  hostErrors: ScheduleHostError[];
  isInitialLoad: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
}

export function useSchedules(): UseSchedulesResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );
  const hostInputs = useMemo<ScheduleHostInput[]>(
    () => hosts.map((host) => ({ serverId: host.serverId, serverName: host.label })),
    [hosts],
  );

  const query = useQuery({
    queryKey: [...schedulesQueryKey(hostInputs.map((host) => host.serverId)), runtimeVersion],
    queryFn: () => fetchAggregatedSchedules({ hosts: hostInputs, runtime }),
    staleTime: 5_000,
    placeholderData: keepPreviousData,
  });

  return {
    schedules: query.data?.schedules ?? [],
    hostErrors: query.data?.hostErrors ?? [],
    isInitialLoad: query.isLoading && query.data === undefined,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
