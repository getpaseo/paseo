import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDaemonRegistry, type DaemonProfile } from "./daemon-registry-context";
import { trackAnalyticsEvent } from "@/utils/analytics";
import type { SessionContextValue } from "./session-context";

export interface SessionDirectoryEntry {
  getSnapshot: () => SessionContextValue | null;
  subscribe: (listener: () => void) => () => void;
}

export type SessionAccessorRole = "primary" | "background";
type SessionAccessorRegistry = Map<string, Map<SessionAccessorRole, SessionDirectoryEntry>>;

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
  activeDaemonId: string | null;
  activeDaemon: DaemonProfile | null;
  connectionStates: Map<string, DaemonConnectionRecord>;
  isLoading: boolean;
  setActiveDaemonId: (daemonId: string, options?: SetActiveDaemonOptions) => void;
  updateConnectionStatus: (daemonId: string, update: ConnectionStateUpdate) => void;
  sessionAccessors: Map<string, SessionDirectoryEntry>;
  sessionAccessorRoles: Map<string, Set<SessionAccessorRole>>;
  registerSessionAccessor: (
    daemonId: string,
    entry: SessionDirectoryEntry,
    role?: SessionAccessorRole
  ) => void;
  unregisterSessionAccessor: (daemonId: string, role?: SessionAccessorRole) => void;
  subscribeToSessionDirectory: (listener: () => void) => () => void;
  notifySessionDirectoryChange: () => void;
}

const DaemonConnectionsContext = createContext<DaemonConnectionsContextValue | null>(null);

const ACTIVE_DAEMON_STORAGE_KEY = "@paseo:active-daemon-id";
const ACTIVE_DAEMON_QUERY_KEY = ["active-daemon-id"];

export type SetActiveDaemonOptions = {
  source?: string;
};

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
  const [activeDaemonId, setActiveDaemonIdState] = useState<string | null>(null);
  const [connectionStates, setConnectionStates] = useState<Map<string, DaemonConnectionRecord>>(new Map());
  const [sessionAccessorRegistry, setSessionAccessorRegistry] = useState<SessionAccessorRegistry>(new Map());
  const queryClient = useQueryClient();
  const activeDaemonPreference = useQuery({
    queryKey: ACTIVE_DAEMON_QUERY_KEY,
    queryFn: loadActiveDaemonPreference,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const sessionDirectoryListenersRef = useRef<Set<() => void>>(new Set());

  useEffect(() => {
    if (activeDaemonPreference.isPending) {
      return;
    }
    setActiveDaemonIdState(activeDaemonPreference.data ?? null);
  }, [activeDaemonPreference.data, activeDaemonPreference.isPending]);

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

      for (const [daemonId, roleMap] of prev.entries()) {
        if (!validDaemonIds.has(daemonId)) {
          changed = true;
          continue;
        }
        next.set(daemonId, roleMap);
      }

      return changed ? next : prev;
    });
  }, [daemons]);

  // Keep active daemon aligned with registry default
  const persistActiveDaemonId = useCallback(async (daemonId: string | null) => {
    queryClient.setQueryData<string | null>(ACTIVE_DAEMON_QUERY_KEY, daemonId);
    try {
      if (daemonId) {
        await AsyncStorage.setItem(ACTIVE_DAEMON_STORAGE_KEY, daemonId);
      } else {
        await AsyncStorage.removeItem(ACTIVE_DAEMON_STORAGE_KEY);
      }
    } catch (error) {
      console.error("[DaemonConnections] Failed to persist active daemon", error);
    }
  }, [queryClient]);

  const setActiveDaemonId = useCallback(
    (daemonId: string, options?: SetActiveDaemonOptions) => {
      setActiveDaemonIdState((previous) => {
        if (previous !== daemonId) {
          trackAnalyticsEvent({
            type: "daemon_active_changed",
            daemonId,
            previousDaemonId: previous,
            source: options?.source,
          });
        }
        return daemonId;
      });
      void persistActiveDaemonId(daemonId);
    },
    [persistActiveDaemonId]
  );

  useEffect(() => {
    if (activeDaemonPreference.isPending) {
      return;
    }

    if (daemons.length === 0) {
      setActiveDaemonIdState(null);
      void persistActiveDaemonId(null);
      return;
    }

    if (activeDaemonId && daemons.some((daemon) => daemon.id === activeDaemonId)) {
      return;
    }

    const fallback = daemons[0];
    if (fallback) {
      setActiveDaemonId(fallback.id, { source: "auto_fallback" });
    }
  }, [daemons, activeDaemonId, activeDaemonPreference.isPending, persistActiveDaemonId, setActiveDaemonId]);

  const activeDaemon = useMemo(() => {
    if (!activeDaemonId) {
      return null;
    }
    return daemons.find((daemon) => daemon.id === activeDaemonId) ?? null;
  }, [activeDaemonId, daemons]);

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

  const registerSessionAccessor = useCallback(
    (daemonId: string, entry: SessionDirectoryEntry, role: SessionAccessorRole = "primary") => {
      setSessionAccessorRegistry((prev) => {
        const next = new Map(prev);
        const existing = new Map(next.get(daemonId) ?? []);
        existing.set(role, entry);
        next.set(daemonId, existing);
        return next;
      });
    },
    []
  );

  const unregisterSessionAccessor = useCallback(
    (daemonId: string, role: SessionAccessorRole = "primary") => {
      setSessionAccessorRegistry((prev) => {
        const existing = prev.get(daemonId);
        if (!existing) {
          return prev;
        }

        const nextRoleMap = new Map(existing);
        nextRoleMap.delete(role);

        const next = new Map(prev);
        if (nextRoleMap.size === 0) {
          next.delete(daemonId);
        } else {
          next.set(daemonId, nextRoleMap);
        }
        return next;
      });
    },
    []
  );

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

  const { sessionAccessors, sessionAccessorRoles } = useMemo(() => {
    const flattened = new Map<string, SessionDirectoryEntry>();
    const roleSets = new Map<string, Set<SessionAccessorRole>>();

    sessionAccessorRegistry.forEach((roleMap, daemonId) => {
      if (roleMap.size === 0) {
        return;
      }

      const roles = new Set<SessionAccessorRole>();
      roleMap.forEach((_entry, role) => roles.add(role));
      roleSets.set(daemonId, roles);

      const primaryEntry = roleMap.get("primary");
      if (primaryEntry) {
        flattened.set(daemonId, primaryEntry);
        return;
      }

      const backgroundEntry = roleMap.get("background");
      if (backgroundEntry) {
        flattened.set(daemonId, backgroundEntry);
      }
    });

    return { sessionAccessors: flattened, sessionAccessorRoles: roleSets };
  }, [sessionAccessorRegistry]);

  const value: DaemonConnectionsContextValue = {
    activeDaemonId,
    activeDaemon,
    connectionStates,
    isLoading: registryLoading || activeDaemonPreference.isPending,
    setActiveDaemonId,
    updateConnectionStatus,
    sessionAccessors,
    sessionAccessorRoles,
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

async function loadActiveDaemonPreference(): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(ACTIVE_DAEMON_STORAGE_KEY);
    return stored ?? null;
  } catch (error) {
    console.error("[DaemonConnections] Failed to read active daemon preference", error);
    throw error;
  }
}
