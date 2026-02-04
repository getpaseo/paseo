import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useDaemonRegistry, type HostProfile } from "./daemon-registry-context";

export type ActiveConnection =
  | { type: "direct"; endpoint: string; display: string }
  | { type: "relay"; endpoint: string; display: "relay" };

export type ConnectionState =
  | { status: "idle"; activeConnection: ActiveConnection | null; lastError: null; lastOnlineAt: string | null; agentListReady: false; hasEverReceivedAgentList: false }
  | { status: "connecting"; activeConnection: ActiveConnection | null; lastError: null; lastOnlineAt: string | null; agentListReady: false; hasEverReceivedAgentList: boolean }
  | { status: "online"; activeConnection: ActiveConnection | null; lastError: null; lastOnlineAt: string; agentListReady: boolean; hasEverReceivedAgentList: boolean }
  | { status: "offline"; activeConnection: ActiveConnection | null; lastError: string | null; lastOnlineAt: string | null; agentListReady: false; hasEverReceivedAgentList: boolean }
  | { status: "error"; activeConnection: ActiveConnection | null; lastError: string; lastOnlineAt: string | null; agentListReady: false; hasEverReceivedAgentList: boolean };

export type ConnectionStatus = ConnectionState["status"];

type ConnectionStateUpdate =
  | { status: "idle" }
  | { status: "connecting"; activeConnection?: ActiveConnection | null; lastOnlineAt?: string | null }
  | { status: "online"; activeConnection?: ActiveConnection | null; lastOnlineAt: string; agentListReady?: boolean }
  | { status: "offline"; activeConnection?: ActiveConnection | null; lastError?: string | null; lastOnlineAt?: string | null }
  | { status: "error"; activeConnection?: ActiveConnection | null; lastError: string; lastOnlineAt?: string | null };

export type DaemonConnectionRecord = {
  daemon: HostProfile;
} & ConnectionState;

interface DaemonConnectionsContextValue {
  connectionStates: Map<string, DaemonConnectionRecord>;
  isLoading: boolean;
  updateConnectionStatus: (serverId: string, update: ConnectionStateUpdate) => void;
}

const DaemonConnectionsContext = createContext<DaemonConnectionsContextValue | null>(null);

function createDefaultConnectionState(): ConnectionState {
  return {
    status: "idle",
    activeConnection: null,
    lastError: null,
    lastOnlineAt: null,
    agentListReady: false,
    hasEverReceivedAgentList: false,
  };
}

function resolveNextConnectionState(
  existing: ConnectionState,
  update: ConnectionStateUpdate
): ConnectionState {
  switch (update.status) {
    case "idle":
      return {
        status: "idle",
        activeConnection: existing.activeConnection ?? null,
        lastError: null,
        lastOnlineAt: existing.lastOnlineAt,
        agentListReady: false,
        hasEverReceivedAgentList: false,
      };
    case "connecting":
      return {
        status: "connecting",
        activeConnection: update.activeConnection ?? existing.activeConnection ?? null,
        lastError: null,
        lastOnlineAt: update.lastOnlineAt ?? existing.lastOnlineAt,
        agentListReady: false,
        hasEverReceivedAgentList: existing.hasEverReceivedAgentList ?? false,
      };
    case "online":
      const currentAgentListReady = update.agentListReady ?? (existing.status === "online" ? existing.agentListReady : false);

      return {
        status: "online",
        activeConnection: update.activeConnection ?? existing.activeConnection ?? null,
        lastError: null,
        lastOnlineAt: update.lastOnlineAt,
        agentListReady: currentAgentListReady,
        hasEverReceivedAgentList:
          currentAgentListReady || existing.hasEverReceivedAgentList || false,
      };
    case "offline":
      return {
        status: "offline",
        activeConnection: update.activeConnection ?? existing.activeConnection ?? null,
        lastError: update.lastError ?? null,
        lastOnlineAt: update.lastOnlineAt ?? existing.lastOnlineAt,
        agentListReady: false,
        hasEverReceivedAgentList: existing.hasEverReceivedAgentList ?? false,
      };
    case "error":
      return {
        status: "error",
        activeConnection: update.activeConnection ?? existing.activeConnection ?? null,
        lastError: update.lastError,
        lastOnlineAt: update.lastOnlineAt ?? existing.lastOnlineAt,
        agentListReady: false,
        hasEverReceivedAgentList: existing.hasEverReceivedAgentList ?? false,
      };
  }
}

function logConnectionLifecycle(daemon: HostProfile, previous: ConnectionState, next: ConnectionState) {
  const severity: "info" | "warn" = next.status === "error" ? "warn" : "info";
  const logger = severity === "warn" ? console.warn : console.info;

  const logPayload = {
    event: "daemon_connection_state",
    serverId: daemon.serverId,
    label: daemon.label,
    from: previous.status,
    to: next.status,
    lastError: next.lastError ?? null,
    lastOnlineAt: next.lastOnlineAt ?? null,
    timestamp: new Date().toISOString(),
    severity,
  };

  logger("[DaemonConnection]", logPayload);
}

export function useDaemonConnections(): DaemonConnectionsContextValue {
  const ctx = useContext(DaemonConnectionsContext);
  if (!ctx) {
    throw new Error("useDaemonConnections must be used within DaemonConnectionsProvider");
  }
  return ctx;
}

export function DaemonConnectionsProvider({ children }: { children: ReactNode }) {
  const { daemons, isLoading: registryLoading } = useDaemonRegistry();
  const [connectionStates, setConnectionStates] = useState<Map<string, DaemonConnectionRecord>>(new Map());

  // Ensure connection states stay in sync with registry entries
  useEffect(() => {
    setConnectionStates((prev) => {
      const next = new Map<string, DaemonConnectionRecord>();
      for (const daemon of daemons) {
        const existing = prev.get(daemon.serverId);
        next.set(daemon.serverId, {
          daemon,
          ...(existing ?? createDefaultConnectionState()),
        });
      }
      return next;
    });
  }, [daemons]);


  const updateConnectionStatus = useCallback(
    (serverId: string, update: ConnectionStateUpdate) => {
      setConnectionStates((prev) => {
        const existing = prev.get(serverId);
        if (!existing) {
          return prev;
        }
        const nextState = resolveNextConnectionState(existing, update);
        const hasChanged =
          existing.status !== nextState.status ||
          existing.lastError !== nextState.lastError ||
          existing.lastOnlineAt !== nextState.lastOnlineAt;

        if (hasChanged) {
          logConnectionLifecycle(existing.daemon, existing, nextState);
        }

        const next = new Map(prev);
        next.set(serverId, { daemon: existing.daemon, ...nextState });
        return next;
      });
    },
    []
  );

  const value: DaemonConnectionsContextValue = {
    connectionStates,
    isLoading: registryLoading,
    updateConnectionStatus,
  };

  return (
    <DaemonConnectionsContext.Provider value={value}>
      {children}
    </DaemonConnectionsContext.Provider>
  );
}
