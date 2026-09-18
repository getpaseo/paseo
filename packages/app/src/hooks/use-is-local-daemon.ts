import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getDesktopDaemonStatus,
  listenToDesktopDaemonStarted,
  shouldUseDesktopDaemon,
} from "@/desktop/daemon/desktop-daemon";
import {
  LOCAL_DAEMON_SERVER_ID_QUERY_KEY,
  applyStartedLocalDaemon,
  probeLocalDaemonServerId,
  resolveLocalDaemonServerIdRefetchInterval,
} from "@/desktop/daemon/local-daemon-server-id";

function useLocalDaemonServerIdQuery() {
  const isDesktopApp = shouldUseDesktopDaemon();

  return useQuery({
    queryKey: LOCAL_DAEMON_SERVER_ID_QUERY_KEY,
    queryFn: ({ client }) => probeLocalDaemonServerId(client, getDesktopDaemonStatus),
    enabled: isDesktopApp,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchInterval: (activeQuery) => resolveLocalDaemonServerIdRefetchInterval(activeQuery.state),
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useLocalDaemonServerId(): string | null {
  const isDesktopApp = shouldUseDesktopDaemon();
  const query = useLocalDaemonServerIdQuery();

  if (!isDesktopApp) {
    return null;
  }

  return query.data?.serverId ?? null;
}

export type LocalDaemonServerIdState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "resolved"; serverId: string | null };

export function useLocalDaemonServerIdState(): LocalDaemonServerIdState {
  const isDesktopApp = shouldUseDesktopDaemon();
  const query = useLocalDaemonServerIdQuery();

  if (!isDesktopApp) {
    return { status: "resolved", serverId: null };
  }
  if (query.isError) {
    return { status: "error" };
  }
  if (query.isSuccess) {
    return { status: "resolved", serverId: query.data.serverId };
  }
  return { status: "loading" };
}

export function useIsLocalDaemon(serverId: string): boolean {
  const normalizedServerId = serverId.trim();
  const localServerId = useLocalDaemonServerId();

  if (localServerId === null || normalizedServerId.length === 0) {
    return false;
  }

  return localServerId === normalizedServerId;
}

// Mount once per window. A daemon started from another window never runs this window's start call,
// and the stopped local server id query doesn't poll.
export function useApplyDesktopDaemonStarts(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!shouldUseDesktopDaemon()) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void listenToDesktopDaemonStarted((status) => {
      void applyStartedLocalDaemon(queryClient, status);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
      return undefined;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);
}
