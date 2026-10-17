import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AddHostModal } from "@/components/add-host-modal";
import { getDaemonStartService } from "@/runtime/daemon-start-service";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { connectionFromListen, hostHasConnection } from "@/types/host-connection";
import type { DiscoveredLocalDaemon } from "@/desktop/daemon/discover-local-daemons";

// Startup credentials must remain reachable on restored host/workspace routes.
export function LocalDaemonConnectionPrompt() {
  const service = getDaemonStartService({ store: getHostRuntimeStore() });
  const pending = useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getPendingLocalConnection(),
    () => service.getPendingLocalConnection(),
  );
  const dismiss = useCallback(() => service.clearPendingLocalConnection(), [service]);
  if (!pending) return null;
  return (
    <LocalDaemonPasswordForm
      key={`${pending.host}:${pending.port}`}
      target={pending}
      onClose={dismiss}
    />
  );
}

function LocalDaemonPasswordForm({
  target,
  onClose,
}: {
  target: DiscoveredLocalDaemon;
  onClose: () => void;
}) {
  const store = getHostRuntimeStore();
  const connection = connectionFromListen(`${target.host}:${target.port}`);
  function readConnectionState() {
    let restoringPassword = false;
    for (const host of store.getHosts()) {
      if (!connection || !hostHasConnection(host, connection)) continue;
      const snapshot = store.getSnapshot(host.serverId);
      if (
        snapshot?.connectionStatus === "online" &&
        snapshot.activeConnectionId === connection.id
      ) {
        return "connected";
      }
      if (host.password && snapshot?.connectionStatus === "connecting" && !snapshot.lastError) {
        restoringPassword = true;
      }
    }
    return restoringPassword ? "connecting" : "password-required";
  }
  const connectionState = useSyncExternalStore(
    (listener) => store.subscribeAll(listener),
    readConnectionState,
    readConnectionState,
  );
  useEffect(() => {
    if (connectionState === "connected") onClose();
  }, [connectionState, onClose]);

  // Let saved credentials finish reconnecting before asking for them again.
  if (connectionState !== "password-required") return null;
  return <AddHostModal visible initialTarget={target} onClose={onClose} onSaved={onClose} />;
}
