import { SessionProvider } from "@/contexts/session-context";
import { useDaemonRegistry } from "@/contexts/daemon-registry-context";

export function MultiDaemonSessionHost() {
  const { daemons } = useDaemonRegistry();
  if (daemons.length === 0) {
    return null;
  }

  return (
    <>
      {daemons.map((daemon) => (
        <SessionProvider key={daemon.id} serverUrl={daemon.wsUrl} serverId={daemon.id}>
          {null}
        </SessionProvider>
      ))}
    </>
  );
}
