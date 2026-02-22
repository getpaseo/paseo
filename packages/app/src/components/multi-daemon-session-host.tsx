import { useEffect } from "react";
import { SessionProvider } from "@/contexts/session-context";
import { useDaemonRegistry, type HostProfile } from "@/contexts/daemon-registry-context";
import {
  getHostRuntimeStore,
  useHostRuntimeSession,
} from "@/runtime/host-runtime";

function ManagedDaemonSession({ daemon }: { daemon: HostProfile }) {
  const { client } = useHostRuntimeSession(daemon.serverId);

  if (!client) {
    return null;
  }

  return (
    <SessionProvider
      key={daemon.serverId}
      serverId={daemon.serverId}
      client={client}
    >
      {null}
    </SessionProvider>
  );
}

export function MultiDaemonSessionHost() {
  const { daemons } = useDaemonRegistry();

  useEffect(() => {
    const runtime = getHostRuntimeStore();
    runtime.syncHosts(daemons);
  }, [daemons]);

  if (daemons.length === 0) {
    return null;
  }

  return (
    <>
      {daemons.map((daemon) => (
        <ManagedDaemonSession key={daemon.serverId} daemon={daemon} />
      ))}
    </>
  );
}
