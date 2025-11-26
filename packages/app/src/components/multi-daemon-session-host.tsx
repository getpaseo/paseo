import { useEffect, useMemo, useRef } from "react";
import { SessionProvider } from "@/contexts/session-context";
import { useDaemonRegistry, type DaemonProfile } from "@/contexts/daemon-registry-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";

export function MultiDaemonSessionHost() {
  const { daemons } = useDaemonRegistry();
  const { activeDaemonId, sessionAccessorRoles } = useDaemonConnections();
  const autoConnectStatesRef = useRef<Map<string, boolean>>(new Map());

  const primaryDaemonIds = useMemo(() => {
    const ids = new Set<string>();
    sessionAccessorRoles.forEach((roles, daemonId) => {
      if (roles.has("primary")) {
        ids.add(daemonId);
      }
    });
    return ids;
  }, [sessionAccessorRoles]);

  useEffect(() => {
    const trackedStates = autoConnectStatesRef.current;
    const activeIds = new Set<string>();

    for (const daemon of daemons) {
      activeIds.add(daemon.id);
      const previousAutoConnect = trackedStates.get(daemon.id);
      if (daemon.autoConnect === false && previousAutoConnect !== false) {
        console.info("[DaemonConnection]", {
          event: "auto_connect_skip",
          daemonId: daemon.id,
          label: daemon.label,
          reason: "autoConnect disabled",
          timestamp: new Date().toISOString(),
        });
      }
      trackedStates.set(daemon.id, daemon.autoConnect);
    }

    for (const daemonId of Array.from(trackedStates.keys())) {
      if (!activeIds.has(daemonId)) {
        trackedStates.delete(daemonId);
      }
    }
  }, [daemons]);

  const backgroundDaemons = useMemo<DaemonProfile[]>(() => {
    const shouldConnect = new Map<string, DaemonProfile>();

    for (const daemon of daemons) {
      if (!daemon.autoConnect) {
        continue;
      }
      if (daemon.id === activeDaemonId) {
        continue;
      }
      if (primaryDaemonIds.has(daemon.id)) {
        continue;
      }
      shouldConnect.set(daemon.id, daemon);
    }

    return Array.from(shouldConnect.values());
  }, [daemons, activeDaemonId, primaryDaemonIds]);

  if (backgroundDaemons.length === 0) {
    return null;
  }

  return (
    <>
      {backgroundDaemons.map((daemon) => (
        <SessionProvider
          key={daemon.id}
          serverUrl={daemon.wsUrl}
          serverId={daemon.id}
          role="background"
        >
          {null}
        </SessionProvider>
      ))}
    </>
  );
}
