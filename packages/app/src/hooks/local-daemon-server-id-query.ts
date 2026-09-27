import type { Query } from "@tanstack/react-query";
import type { DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";

interface DesktopDaemonServerIdResult {
  serverId: string | null;
}

export function localDaemonServerIdQueryOptions(
  getStatus: () => Promise<Pick<DesktopDaemonStatus, "serverId" | "error">>,
) {
  return {
    queryKey: ["desktop-daemon-server-id"] as const,
    queryFn: async (): Promise<DesktopDaemonServerIdResult> => {
      const status = await getStatus();
      if (status.error) throw new Error(status.error);
      const serverId = status.serverId.trim();
      return { serverId: serverId.length > 0 ? serverId : null };
    },
    staleTime: Infinity,
    gcTime: Infinity,
    refetchInterval: (query: Pick<Query<DesktopDaemonServerIdResult>, "state">) => {
      // Each status probe launches the GUI executable on Windows, which flashes the busy cursor.
      if (query.state.status === "error") return false;
      return query.state.data?.serverId ? false : 1000;
    },
    refetchOnMount: true,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    retry: false,
  };
}
