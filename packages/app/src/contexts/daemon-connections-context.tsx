import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDaemonRegistry, type DaemonProfile } from "./daemon-registry-context";
import type { SessionContextValue } from "./session-context";

export interface SessionDirectoryEntry {
  getSnapshot: () => SessionContextValue | null;
  subscribe: (listener: () => void) => () => void;
}

export type ConnectionStatus = "idle" | "connecting" | "online" | "offline" | "error";

export interface DaemonConnectionRecord {
  daemon: DaemonProfile;
  status: ConnectionStatus;
  lastOnlineAt?: string;
  lastError?: string | null;
}

interface DaemonConnectionsContextValue {
  activeDaemonId: string | null;
  activeDaemon: DaemonProfile | null;
  connectionStates: Map<string, DaemonConnectionRecord>;
  isLoading: boolean;
  setActiveDaemonId: (daemonId: string) => void;
  updateConnectionStatus: (
    daemonId: string,
    status: ConnectionStatus,
    extras?: { lastError?: string | null; lastOnlineAt?: string }
  ) => void;
  sessionAccessors: Map<string, SessionDirectoryEntry>;
  registerSessionAccessor: (daemonId: string, entry: SessionDirectoryEntry) => void;
  unregisterSessionAccessor: (daemonId: string) => void;
  subscribeToSessionDirectory: (listener: () => void) => () => void;
  notifySessionDirectoryChange: () => void;
}

const DaemonConnectionsContext = createContext<DaemonConnectionsContextValue | null>(null);

const ACTIVE_DAEMON_STORAGE_KEY = "@paseo:active-daemon-id";
const ACTIVE_DAEMON_QUERY_KEY = ["active-daemon-id"];

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
  const [sessionAccessors, setSessionAccessors] = useState<Map<string, SessionDirectoryEntry>>(new Map());
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
          status: existing?.status ?? "idle",
          lastOnlineAt: existing?.lastOnlineAt,
          lastError: existing?.lastError,
        });
      }
      return next;
    });
  }, [daemons]);

  useEffect(() => {
    setSessionAccessors((prev) => {
      const next = new Map(prev);
      for (const key of Array.from(next.keys())) {
        if (!daemons.some((daemon) => daemon.id === key)) {
          next.delete(key);
        }
      }
      return next;
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
    (daemonId: string) => {
      setActiveDaemonIdState(daemonId);
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

    const fallback = daemons.find((daemon) => daemon.isDefault) ?? daemons[0];
    setActiveDaemonId(fallback.id);
  }, [daemons, activeDaemonId, activeDaemonPreference.isPending, persistActiveDaemonId, setActiveDaemonId]);

  const activeDaemon = useMemo(() => {
    if (!activeDaemonId) {
      return null;
    }
    return daemons.find((daemon) => daemon.id === activeDaemonId) ?? null;
  }, [activeDaemonId, daemons]);

  const updateConnectionStatus = useCallback(
    (
      daemonId: string,
      status: ConnectionStatus,
      extras?: { lastError?: string | null; lastOnlineAt?: string }
    ) => {
      setConnectionStates((prev) => {
        const next = new Map(prev);
        const existing = next.get(daemonId);
        if (!existing) {
          return prev;
        }
        const hasExplicitLastError = Boolean(extras && Object.prototype.hasOwnProperty.call(extras, "lastError"));
        next.set(daemonId, {
          ...existing,
          status,
          lastError: hasExplicitLastError ? (extras!.lastError ?? null) : existing.lastError ?? null,
          lastOnlineAt: extras?.lastOnlineAt ?? existing.lastOnlineAt,
        });
        return next;
      });
    },
    []
  );

  const registerSessionAccessor = useCallback((daemonId: string, entry: SessionDirectoryEntry) => {
    setSessionAccessors((prev) => {
      const next = new Map(prev);
      next.set(daemonId, entry);
      return next;
    });
  }, []);

  const unregisterSessionAccessor = useCallback((daemonId: string) => {
    setSessionAccessors((prev) => {
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

  const value: DaemonConnectionsContextValue = {
    activeDaemonId,
    activeDaemon,
    connectionStates,
    isLoading: registryLoading || activeDaemonPreference.isPending,
    setActiveDaemonId,
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

async function loadActiveDaemonPreference(): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(ACTIVE_DAEMON_STORAGE_KEY);
    return stored ?? null;
  } catch (error) {
    console.error("[DaemonConnections] Failed to read active daemon preference", error);
    throw error;
  }
}
