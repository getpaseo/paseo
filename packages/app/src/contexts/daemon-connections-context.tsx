import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import {
  getHostRuntimeStore,
  type HostRuntimeAgentDirectoryStatus,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { useDaemonRegistry, type HostProfile } from "./daemon-registry-context";

export type ActiveConnection =
  | { type: "direct"; endpoint: string; display: string }
  | { type: "relay"; endpoint: string; display: "relay" };

export type ConnectionStatus = HostRuntimeConnectionStatus;

export type DaemonConnectionRecord = {
  daemon: HostProfile;
  status: HostRuntimeConnectionStatus;
  activeConnection: ActiveConnection | null;
  lastError: string | null;
  lastOnlineAt: string | null;
  agentDirectoryStatus: HostRuntimeAgentDirectoryStatus;
  agentDirectoryError: string | null;
  hasEverLoadedAgentDirectory: boolean;
};

interface DaemonConnectionsContextValue {
  connectionStates: Map<string, DaemonConnectionRecord>;
  isLoading: boolean;
}

const DaemonConnectionsContext = createContext<DaemonConnectionsContextValue | null>(null);

function buildConnectionStates(input: {
  daemons: HostProfile[];
  runtime: ReturnType<typeof getHostRuntimeStore>;
}): Map<string, DaemonConnectionRecord> {
  const { daemons, runtime } = input;
  const next = new Map<string, DaemonConnectionRecord>();

  for (const daemon of daemons) {
    const snapshot = runtime.getSnapshot(daemon.serverId);
    next.set(daemon.serverId, {
      daemon,
      status: snapshot?.connectionStatus ?? "connecting",
      activeConnection: snapshot?.activeConnection ?? null,
      lastError: snapshot?.lastError ?? null,
      lastOnlineAt: snapshot?.lastOnlineAt ?? null,
      agentDirectoryStatus: snapshot?.agentDirectoryStatus ?? "initial_loading",
      agentDirectoryError: snapshot?.agentDirectoryError ?? null,
      hasEverLoadedAgentDirectory:
        snapshot?.hasEverLoadedAgentDirectory ?? false,
    });
  }

  return next;
}

export function useDaemonConnections(): DaemonConnectionsContextValue {
  const ctx = useContext(DaemonConnectionsContext);
  if (!ctx) {
    throw new Error(
      "useDaemonConnections must be used within DaemonConnectionsProvider"
    );
  }
  return ctx;
}

export function DaemonConnectionsProvider({ children }: { children: ReactNode }) {
  const { daemons, isLoading: registryLoading } = useDaemonRegistry();
  const runtime = getHostRuntimeStore();

  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion()
  );

  const connectionStates = useMemo(
    () => buildConnectionStates({ daemons, runtime }),
    [daemons, runtime, runtimeVersion]
  );

  const value = useMemo<DaemonConnectionsContextValue>(
    () => ({
      connectionStates,
      isLoading: registryLoading,
    }),
    [connectionStates, registryLoading]
  );

  return (
    <DaemonConnectionsContext.Provider value={value}>
      {children}
    </DaemonConnectionsContext.Provider>
  );
}
