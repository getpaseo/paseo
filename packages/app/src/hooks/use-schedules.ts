import { useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import {
  fetchAggregatedSchedules,
  type ScheduleHostInput,
  type ScheduleHostSection,
} from "@/schedules/aggregated-schedules";

export type { ScheduleHostSection } from "@/schedules/aggregated-schedules";

export const schedulesQueryBaseKey = ["schedules"] as const;

export function schedulesQueryKey(hosts: readonly ScheduleHostInput[]) {
  return [...schedulesQueryBaseKey, hosts.map((host) => host.serverId).join("|")] as const;
}

export interface UseSchedulesResult {
  sections: ScheduleHostSection[];
  isLoading: boolean;
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
    () =>
      hosts.map((host) => ({
        serverId: host.serverId,
        serverName: host.label,
      })),
    [hosts],
  );

  const query = useQuery({
    queryKey: [...schedulesQueryKey(hostInputs), runtimeVersion] as const,
    queryFn: () => fetchAggregatedSchedules({ hosts: hostInputs, runtime }),
    staleTime: 5_000,
  });

  return {
    sections: query.data?.sections ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
