import { useEffect, useMemo, useRef } from "react";
import { SessionProvider } from "@/contexts/session-context";
import { useDaemonRegistry, type DaemonProfile } from "@/contexts/daemon-registry-context";

export function MultiDaemonSessionHost() {
  const { daemons } = useDaemonRegistry();
  const autoConnectStatesRef = useRef<Map<string, boolean>>(new Map());

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

  const connectedDaemons = useMemo<DaemonProfile[]>(() => {
    return daemons.filter((daemon) => daemon.autoConnect !== false);
  }, [daemons]);

  if (connectedDaemons.length === 0) {
    return null;
  }

  return (
    <>
      {connectedDaemons.map((daemon) => (
        <SessionProvider key={daemon.id} serverUrl={daemon.wsUrl} serverId={daemon.id}>
          {null}
        </SessionProvider>
      ))}
    </>
  );
}
