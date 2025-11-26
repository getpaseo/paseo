import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useDaemonRegistry, type DaemonProfile } from "./daemon-registry-context";
import type { SessionContextValue } from "./session-context";

export interface SessionDirectoryEntry {
  getSnapshot: () => SessionContextValue | null;
  subscribe: (listener: () => void) => () => void;
}
type SessionAccessorRegistry = Map<string, SessionDirectoryEntry>;

export type ConnectionState =
  | { status: "idle"; lastError: null; lastOnlineAt: string | null }
  | { status: "connecting"; lastError: null; lastOnlineAt: string | null }
  | { status: "online"; lastError: null; lastOnlineAt: string }
  | { status: "offline"; lastError: string | null; lastOnlineAt: string | null }
  | { status: "error"; lastError: string; lastOnlineAt: string | null };

export type ConnectionStatus = ConnectionState["status"];

type ConnectionStateUpdate =
  | { status: "idle" }
  | { status: "connecting"; lastOnlineAt?: string | null }
  | { status: "online"; lastOnlineAt: string }
  | { status: "offline"; lastError?: string | null; lastOnlineAt?: string | null }
  | { status: "error"; lastError: string; lastOnlineAt?: string | null };

export type DaemonConnectionRecord = {
  daemon: DaemonProfile;
} & ConnectionState;

interface DaemonConnectionsContextValue {
  connectionStates: Map<string, DaemonConnectionRecord>;
  isLoading: boolean;
  updateConnectionStatus: (daemonId: string, update: ConnectionStateUpdate) => void;
  sessionAccessors: Map<string, SessionDirectoryEntry>;
  registerSessionAccessor: (daemonId: string, entry: SessionDirectoryEntry) => void;
  unregisterSessionAccessor: (daemonId: string) => void;
  subscribeToSessionDirectory: (listener: () => void) => () => void;
  notifySessionDirectoryChange: () => void;
}

const DaemonConnectionsContext = createContext<DaemonConnectionsContextValue | null>(null);

function createDefaultConnectionState(): ConnectionState {
  return {
    status: "idle",
    lastError: null,
    lastOnlineAt: null,
  };
}

function resolveNextConnectionState(
  existing: ConnectionState,
  update: ConnectionStateUpdate
): ConnectionState {
  switch (update.status) {
    case "idle":
      return { status: "idle", lastError: null, lastOnlineAt: existing.lastOnlineAt };
    case "connecting":
      return {
        status: "connecting",
        lastError: null,
        lastOnlineAt: update.lastOnlineAt ?? existing.lastOnlineAt,
      };
    case "online":
      return { status: "online", lastError: null, lastOnlineAt: update.lastOnlineAt };
    case "offline":
      return {
        status: "offline",
        lastError: update.lastError ?? null,
        lastOnlineAt: update.lastOnlineAt ?? existing.lastOnlineAt,
      };
    case "error":
      return {
        status: "error",
        lastError: update.lastError,
        lastOnlineAt: update.lastOnlineAt ?? existing.lastOnlineAt,
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
  const [sessionAccessorRegistry, setSessionAccessorRegistry] = useState<SessionAccessorRegistry>(new Map());
  const sessionDirectoryListenersRef = useRef<Set<() => void>>(new Set());

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
    setSessionAccessorRegistry((prev) => {
      const validDaemonIds = new Set(daemons.map((daemon) => daemon.id));
      let changed = false;
      const next: SessionAccessorRegistry = new Map();

      for (const [daemonId, entry] of prev.entries()) {
        if (!validDaemonIds.has(daemonId)) {
          changed = true;
          continue;
        }
        next.set(daemonId, entry);
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

  const registerSessionAccessor = useCallback((daemonId: string, entry: SessionDirectoryEntry) => {
    setSessionAccessorRegistry((prev) => {
      const next = new Map(prev);
      const hasExisting = next.has(daemonId);
      next.set(daemonId, entry);
      if (hasExisting) {
        console.warn(`[DaemonConnections] Duplicate session accessor detected for "${daemonId}". Overwriting.`);
      }
      return next;
    });
  }, []);

  const unregisterSessionAccessor = useCallback((daemonId: string) => {
    setSessionAccessorRegistry((prev) => {
      if (!prev.has(daemonId)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(daemonId);
      return next;
    });
  }, []);

  const subscribeToSessionDirectory = useCallback((listener: () => void) => {
    sessionDirectoryListenersRef.current.add(listener);
    return () => {
      sessionDirectoryListenersRef.current.delete(listener);
    };
  }, []);

  const notifySessionDirectoryChange = useCallback(() => {
    const listeners = Array.from(sessionDirectoryListenersRef.current);
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[DaemonConnections] Session directory listener failed", error);
      }
    }
  }, []);

  const sessionAccessors = useMemo(() => new Map(sessionAccessorRegistry), [sessionAccessorRegistry]);

  const value: DaemonConnectionsContextValue = {
    connectionStates,
    isLoading: registryLoading,
    updateConnectionStatus,
    sessionAccessors,
    registerSessionAccessor,
    unregisterSessionAccessor,
    subscribeToSessionDirectory,
    notifySessionDirectoryChange,
  };

  return (
    <DaemonConnectionsContext.Provider value={value}>
      {children}
    </DaemonConnectionsContext.Provider>
  );
}
