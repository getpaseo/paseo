import type { QueryClient, QueryStatus } from "@tanstack/react-query";
import type { DesktopDaemonState, DesktopDaemonStatus } from "./desktop-daemon";

export const LOCAL_DAEMON_SERVER_ID_QUERY_KEY = ["desktop-daemon-server-id"] as const;

const POLL_INTERVAL_MS = 1000;
const MAX_PROBES_WITHOUT_SERVER_ID = 60;

export interface LocalDaemonServerId {
  serverId: string | null;
  status: DesktopDaemonState;
  // Consecutive probes without a server id since the last start. Bounds polling.
  probesWithoutServerId: number;
}

function readServerId(daemon: DesktopDaemonStatus): string | null {
  const serverId = daemon.serverId.trim();
  return serverId.length > 0 ? serverId : null;
}

export async function probeLocalDaemonServerId(
  queryClient: QueryClient,
  getStatus: () => Promise<DesktopDaemonStatus>,
): Promise<LocalDaemonServerId> {
  const daemon = await getStatus();
  const serverId = readServerId(daemon);
  const previous = queryClient.getQueryData<LocalDaemonServerId>(LOCAL_DAEMON_SERVER_ID_QUERY_KEY);
  return {
    serverId,
    status: daemon.status,
    probesWithoutServerId: serverId ? 0 : (previous?.probesWithoutServerId ?? 0) + 1,
  };
}

// Every poll runs `paseo daemon status` in a new process, and status only reports a server id for
// a reachable daemon. Poll a bounded number of times while a daemon exists without an observed id.
// A stopped daemon is not polled; applyStartedLocalDaemon records it once a start completes.
export function resolveLocalDaemonServerIdRefetchInterval(state: {
  data: LocalDaemonServerId | undefined;
  status: QueryStatus;
}): number | false {
  const { data } = state;
  if (state.status === "error" || !data || data.serverId !== null) return false;
  if (data.status !== "starting" && data.status !== "running") return false;
  return data.probesWithoutServerId < MAX_PROBES_WITHOUT_SERVER_ID ? POLL_INTERVAL_MS : false;
}

// Runs in every window for each desktop daemon start, possibly more than once per start. The
// server id belongs to the home, so a start that couldn't observe it keeps the one already known.
export async function applyStartedLocalDaemon(
  queryClient: QueryClient,
  daemon: DesktopDaemonStatus,
): Promise<void> {
  const started: LocalDaemonServerId = {
    serverId: readServerId(daemon),
    status: daemon.status,
    probesWithoutServerId: 0,
  };
  // Stop an in-flight probe from overwriting the start's result when it lands.
  await queryClient.cancelQueries({ queryKey: LOCAL_DAEMON_SERVER_ID_QUERY_KEY });
  queryClient.setQueryData<LocalDaemonServerId>(LOCAL_DAEMON_SERVER_ID_QUERY_KEY, (current) =>
    started.serverId === null && current?.serverId ? current : started,
  );
}
