import { useEffect, useMemo, useState } from "react";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import type { SessionContextValue } from "@/contexts/session-context";

export function useSessionDirectory(): Map<string, SessionContextValue | null> {
  const { sessionAccessors, subscribeToSessionDirectory } = useDaemonConnections();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    return subscribeToSessionDirectory(() => {
      setRevision((current) => current + 1);
    });
  }, [subscribeToSessionDirectory]);

  return useMemo(() => {
    const entries = new Map<string, SessionContextValue | null>();
    sessionAccessors.forEach((entry, serverId) => {
      try {
        entries.set(serverId, entry.getSnapshot());
      } catch (error) {
        console.error(`[useSessionDirectory] Failed to read session accessor for "${serverId}"`, error);
        entries.set(serverId, null);
      }
    });
    return entries;
  }, [sessionAccessors, revision]);
}

export function useSessionForServer(serverId: string | null): SessionContextValue | null {
  const directory = useSessionDirectory();
  if (!serverId) {
    return null;
  }
  return directory.get(serverId) ?? null;
}
