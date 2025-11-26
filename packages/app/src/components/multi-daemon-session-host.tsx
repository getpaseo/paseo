import { useMemo } from "react";
import { SessionProvider } from "@/contexts/session-context";
import { useDaemonRegistry, type DaemonProfile } from "@/contexts/daemon-registry-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";

export function MultiDaemonSessionHost() {
  const { daemons } = useDaemonRegistry();
  const { activeDaemonId } = useDaemonConnections();

  const backgroundDaemons = useMemo<DaemonProfile[]>(() => {
    const shouldConnect = new Map<string, DaemonProfile>();

    for (const daemon of daemons) {
      if (daemon.autoConnect) {
        shouldConnect.set(daemon.id, daemon);
      }
    }

    if (activeDaemonId) {
      const activeDaemon = daemons.find((daemon) => daemon.id === activeDaemonId);
      if (activeDaemon) {
        shouldConnect.set(activeDaemon.id, activeDaemon);
      }
      // The active daemon already wraps the UI tree via ProvidersWrapper,
      // so we skip rendering it here to avoid duplicate websocket connections.
      shouldConnect.delete(activeDaemonId);
    }

    return Array.from(shouldConnect.values());
  }, [daemons, activeDaemonId]);

  if (backgroundDaemons.length === 0) {
    return null;
  }

  return (
    <>
      {backgroundDaemons.map((daemon) => (
        <SessionProvider key={daemon.id} serverUrl={daemon.wsUrl} serverId={daemon.id}>
          {null}
        </SessionProvider>
      ))}
    </>
  );
}
