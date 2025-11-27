import { useMemo } from "react";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import type { SessionContextValue } from "@/contexts/session-context";

export function useSessionDirectory(): Map<string, SessionContextValue> {
  const { sessionSnapshots } = useDaemonConnections();

  return useMemo(() => {
    const entries = new Map<string, SessionContextValue>();
    sessionSnapshots.forEach((snapshot, serverId) => {
      entries.set(serverId, snapshot);
    });
    return entries;
  }, [sessionSnapshots]);
}

export function useSessionForServer(serverId: string | null): SessionContextValue | null {
  const { sessionSnapshots } = useDaemonConnections();
  return serverId ? sessionSnapshots.get(serverId) ?? null : null;
}
