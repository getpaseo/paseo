import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useDaemonRegistry, type DaemonProfile } from "./daemon-registry-context";
import type { SessionContextValue } from "./session-context";

export type SessionSnapshot = SessionContextValue;

export type ConnectionState =
  | { status: "idle"; lastError: null; lastOnlineAt: string | null; sessionReady: false }
  | { status: "connecting"; lastError: null; lastOnlineAt: string | null; sessionReady: false }
  | { status: "online"; lastError: null; lastOnlineAt: string; sessionReady: boolean }
  | { status: "offline"; lastError: string | null; lastOnlineAt: string | null; sessionReady: false }
  | { status: "error"; lastError: string; lastOnlineAt: string | null; sessionReady: false };

export type ConnectionStatus = ConnectionState["status"];

type ConnectionStateUpdate =
  | { status: "idle" }
  | { status: "connecting"; lastOnlineAt?: string | null }
  | { status: "online"; lastOnlineAt: string; sessionReady?: boolean }
  | { status: "offline"; lastError?: string | null; lastOnlineAt?: string | null }
  | { status: "error"; lastError: string; lastOnlineAt?: string | null };

export type DaemonConnectionRecord = {
  daemon: DaemonProfile;
} & ConnectionState;

interface DaemonConnectionsContextValue {
  connectionStates: Map<string, DaemonConnectionRecord>;
  isLoading: boolean;
  updateConnectionStatus: (daemonId: string, update: ConnectionStateUpdate) => void;
  sessionSnapshots: Map<string, SessionSnapshot>;
  updateSessionSnapshot: (daemonId: string, snapshot: SessionSnapshot | null) => void;
  clearSessionSnapshot: (daemonId: string) => void;
}

const DaemonConnectionsContext = createContext<DaemonConnectionsContextValue | null>(null);

function createDefaultConnectionState(): ConnectionState {
  return {
    status: "idle",
    lastError: null,
    lastOnlineAt: null,
    sessionReady: false,
  };
}

function resolveNextConnectionState(
  existing: ConnectionState,
  update: ConnectionStateUpdate
): ConnectionState {
  switch (update.status) {
    case "idle":
      return { status: "idle", lastError: null, lastOnlineAt: existing.lastOnlineAt, sessionReady: false };
    case "connecting":
      return {
        status: "connecting",
        lastError: null,
        lastOnlineAt: update.lastOnlineAt ?? existing.lastOnlineAt,
        sessionReady: false,
      };
    case "online":
      return {
        status: "online",
        lastError: null,
        lastOnlineAt: update.lastOnlineAt,
        sessionReady: update.sessionReady ?? (existing.status === "online" ? existing.sessionReady : false),
      };
    case "offline":
      return {
        status: "offline",
        lastError: update.lastError ?? null,
        lastOnlineAt: update.lastOnlineAt ?? existing.lastOnlineAt,
        sessionReady: false,
      };
    case "error":
      return {
        status: "error",
        lastError: update.lastError,
        lastOnlineAt: update.lastOnlineAt ?? existing.lastOnlineAt,
        sessionReady: false,
      };
  }
}

function logConnectionLifecycle(daemon: DaemonProfile, previous: ConnectionState, next: ConnectionState) {
  const logPayload = {
    event: "daemon_connection_state",
    daemonId: daemon.id,
    label: daemon.label,
    from: previous.status,
    to: next.status,
    lastError: next.lastError ?? null,
    lastOnlineAt: next.lastOnlineAt ?? null,
    timestamp: new Date().toISOString(),
  };

  const logger =
    next.status === "error"
      ? console.error
      : next.status === "offline"
        ? console.warn
        : console.info;

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
  const [sessionSnapshotRegistry, setSessionSnapshotRegistry] = useState<Map<string, SessionSnapshot>>(new Map());

  // Ensure connection states stay in sync with registry entries
  useEffect(() => {
    setConnectionStates((prev) => {
      const next = new Map<string, DaemonConnectionRecord>();
      for (const daemon of daemons) {
        const existing = prev.get(daemon.id);
        next.set(daemon.id, {
          daemon,
          ...(existing ?? createDefaultConnectionState()),
        });
      }
      return next;
    });
  }, [daemons]);

  useEffect(() => {
    setSessionSnapshotRegistry((prev) => {
      const validDaemonIds = new Set(daemons.map((daemon) => daemon.id));
      let changed = false;
      const next = new Map<string, SessionSnapshot>();

      for (const [daemonId, snapshot] of prev.entries()) {
        if (!validDaemonIds.has(daemonId)) {
          changed = true;
          continue;
        }
        next.set(daemonId, snapshot);
      }

      return changed ? next : prev;
    });
  }, [daemons]);


  const updateConnectionStatus = useCallback(
    (daemonId: string, update: ConnectionStateUpdate) => {
      setConnectionStates((prev) => {
        const existing = prev.get(daemonId);
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
        next.set(daemonId, { daemon: existing.daemon, ...nextState });
        return next;
      });
    },
    []
  );

  const updateSessionSnapshot = useCallback((serverId: string, snapshot: SessionSnapshot | null) => {
    setSessionSnapshotRegistry((prev) => {
      const next = new Map(prev);
      if (snapshot === null) {
        next.delete(serverId);
      } else {
        next.set(serverId, snapshot);
      }
      return next;
    });
  }, []);

  const clearSessionSnapshot = useCallback((serverId: string) => {
    setSessionSnapshotRegistry((prev) => {
      if (!prev.has(serverId)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(serverId);
      return next;
    });
  }, []);

  const sessionSnapshots = useMemo(() => new Map(sessionSnapshotRegistry), [sessionSnapshotRegistry]);

  const value: DaemonConnectionsContextValue = {
    connectionStates,
    isLoading: registryLoading,
    updateConnectionStatus,
    sessionSnapshots,
    updateSessionSnapshot,
    clearSessionSnapshot,
  };

  return (
    <DaemonConnectionsContext.Provider value={value}>
      {children}
    </DaemonConnectionsContext.Provider>
  );
}
