import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getDesktopDaemonLogs,
  getDesktopDaemonStatus,
  shouldUseDesktopDaemon,
  type DesktopDaemonLogs,
  type DesktopDaemonStatus,
} from "@/desktop/daemon/desktop-daemon";

const DAEMON_STATUS_QUERY_KEY = ["desktopDaemonStatus"] as const;

interface DaemonStatusData {
  status: DesktopDaemonStatus;
  logs: DesktopDaemonLogs;
}

export function useDaemonStatus() {
  const queryClient = useQueryClient();
  const enabled = shouldUseDesktopDaemon();

  const query = useQuery<DaemonStatusData>({
    queryKey: DAEMON_STATUS_QUERY_KEY,
    enabled,
    staleTime: 30_000,
    refetchOnMount: "always",
    queryFn: async () => {
      const [status, logs] = await Promise.all([getDesktopDaemonStatus(), getDesktopDaemonLogs()]);
      return { status, logs };
    },
  });

  const setStatus = useCallback(
    (status: DesktopDaemonStatus) => {
      queryClient.setQueryData<DaemonStatusData>(DAEMON_STATUS_QUERY_KEY, (prev) =>
        prev ? { ...prev, status } : undefined,
      );
    },
    [queryClient],
  );

  const refetch = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: DAEMON_STATUS_QUERY_KEY });
  }, [queryClient]);

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    setStatus,
    refetch,
  };
}
