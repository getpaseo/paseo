import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import {
  fetchAggregatedSchedules,
  schedulesQueryBaseKey,
  type AggregateLoadState,
  type AggregatedSchedule,
  type ScheduleHostError,
  type ScheduleHostInput,
} from "@/schedules/aggregated-schedules";

export type {
  AggregateLoadState,
  AggregatedSchedule,
  ScheduleHostError,
} from "@/schedules/aggregated-schedules";

export function schedulesQueryKey(serverIds: readonly string[]) {
  return [...schedulesQueryBaseKey, [...serverIds].sort().join("|")] as const;
}

export interface UseSchedulesResult {
  loadState: AggregateLoadState<AggregatedSchedule>;
  hostErrors: ScheduleHostError[];
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
}

export function useSchedules(): UseSchedulesResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const hostInputs = useMemo<ScheduleHostInput[]>(
    () => hosts.map((host) => ({ serverId: host.serverId, serverName: host.label })),
    [hosts],
  );
  const serverIds = useMemo(() => hostInputs.map((host) => host.serverId), [hostInputs]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((serverId) => connectionStatuses.get(serverId) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );

  const query = useFetchQuery({
    queryKey: [...schedulesQueryKey(serverIds), connectionStatusKey],
    queryFn: () => fetchAggregatedSchedules({ hosts: hostInputs, runtime }),
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  let loadState: AggregateLoadState<AggregatedSchedule>;
  if (query.data?.status === "connecting") {
    loadState = { status: "connecting" };
  } else if (query.data?.status === "loaded") {
    loadState = { status: "loaded", data: query.data.data };
  } else {
    loadState = { status: "loading" };
  }

  return {
    loadState,
    hostErrors: query.data?.status === "loaded" ? query.data.hostErrors : [],
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
