import { useQuery } from "@tanstack/react-query";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { useSessionStore } from "@/stores/session-store";
import { isNewAgentSchedule } from "@/utils/schedule-format";

export function schedulesQueryKey(serverId: string) {
  return ["schedules", serverId] as const;
}

export interface UseSchedulesInput {
  serverId: string;
}

export interface UseSchedulesResult {
  schedules: ScheduleSummary[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
}

async function fetchNewAgentSchedules(serverId: string): Promise<ScheduleSummary[]> {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error("Daemon client not available");
  }

  const payload = await client.scheduleList();
  if (payload.error) {
    throw new Error(payload.error);
  }

  return payload.schedules.filter(isNewAgentSchedule);
}

export function useSchedules({ serverId }: UseSchedulesInput): UseSchedulesResult {
  const hasClient = useSessionStore((state) => (state.sessions[serverId]?.client ?? null) !== null);

  const query = useQuery({
    queryKey: schedulesQueryKey(serverId),
    queryFn: () => fetchNewAgentSchedules(serverId),
    enabled: hasClient,
    staleTime: 5_000,
  });

  return {
    schedules: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
