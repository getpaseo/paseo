import { createContext, useCallback, useContext } from "react";
import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const REGISTRY_STORAGE_KEY = "@paseo:daemon-registry";
const LEGACY_SETTINGS_KEY = "@paseo:settings";
const FALLBACK_DAEMON_URL = "ws://localhost:6767/ws";
const DAEMON_REGISTRY_QUERY_KEY = ["daemon-registry"];

export type DaemonProfile = {
  id: string;
  label: string;
  wsUrl: string;
  restUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown> | null;
};

type CreateDaemonInput = {
  label: string;
  wsUrl: string;
  restUrl?: string | null;
};

type UpdateDaemonInput = Partial<Omit<DaemonProfile, "id" | "createdAt">>;

interface DaemonRegistryContextValue {
  daemons: DaemonProfile[];
  isLoading: boolean;
  error: unknown | null;
  addDaemon: (input: CreateDaemonInput) => Promise<DaemonProfile>;
  updateDaemon: (id: string, updates: UpdateDaemonInput) => Promise<void>;
  removeDaemon: (id: string) => Promise<void>;
}

const DaemonRegistryContext = createContext<DaemonRegistryContextValue | null>(null);

export function useDaemonRegistry(): DaemonRegistryContextValue {
  const ctx = useContext(DaemonRegistryContext);
  if (!ctx) {
    throw new Error("useDaemonRegistry must be used within DaemonRegistryProvider");
  }
  return ctx;
}

export function DaemonRegistryProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: daemons = [], isPending, error } = useQuery({
    queryKey: DAEMON_REGISTRY_QUERY_KEY,
    queryFn: loadDaemonRegistryFromStorage,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const persist = useCallback(
    async (profiles: DaemonProfile[]) => {
      queryClient.setQueryData<DaemonProfile[]>(DAEMON_REGISTRY_QUERY_KEY, profiles);
      await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(profiles));
    },
    [queryClient]
  );

  const readDaemons = useCallback(() => {
    return queryClient.getQueryData<DaemonProfile[]>(DAEMON_REGISTRY_QUERY_KEY) ?? daemons;
  }, [queryClient, daemons]);

  const addDaemon = useCallback(async (input: CreateDaemonInput) => {
    const existing = readDaemons();
    const timestamp = new Date().toISOString();
    const profile: DaemonProfile = {
      id: generateDaemonId(),
      label: input.label.trim() || deriveLabelFromUrl(input.wsUrl),
      wsUrl: input.wsUrl,
      restUrl: input.restUrl ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: null,
    };

    const next = [...existing, profile];
    await persist(next);
    return profile;
  }, [persist, readDaemons]);

  const updateDaemon = useCallback(async (id: string, updates: UpdateDaemonInput) => {
    const next = readDaemons().map((daemon) =>
      daemon.id === id
        ? {
            ...daemon,
            ...updates,
            updatedAt: new Date().toISOString(),
          }
        : daemon
    );
    await persist(next);
  }, [persist, readDaemons]);

  const removeDaemon = useCallback(async (id: string) => {
    const remaining = readDaemons().filter((daemon) => daemon.id !== id);
    const next = remaining.length > 0 ? remaining : [createProfile("Local Host", FALLBACK_DAEMON_URL)];
    await persist(next);
  }, [persist, readDaemons]);

  const value: DaemonRegistryContextValue = {
    daemons,
    isLoading: isPending,
    error: error ?? null,
    addDaemon,
    updateDaemon,
    removeDaemon,
  };

  return (
    <DaemonRegistryContext.Provider value={value}>
      {children}
    </DaemonRegistryContext.Provider>
  );
}

function generateDaemonId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `daemon_${Date.now().toString(36)}_${random}`;
}

function deriveLabelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || "Unnamed Host";
  } catch {
    return "Unnamed Host";
  }
}

function createProfile(label: string, wsUrl: string): DaemonProfile {
  const timestamp = new Date().toISOString();
  return {
    id: generateDaemonId(),
    label,
    wsUrl,
    restUrl: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: null,
  };
}

type EnvDaemonConfig = {
  label?: string;
  wsUrl: string;
  restUrl?: string | null;
};

function parseEnvDaemonDefaults(): DaemonProfile[] {
  const envDaemons = (() => {
    // Primary: allow a JSON array string like
    // EXPO_PUBLIC_DAEMONS='[{"label":"Host","wsUrl":"ws://10.0.0.1:6767/ws"}]'
    const jsonList = process.env.EXPO_PUBLIC_DAEMONS;
    if (jsonList) {
      try {
        const parsed = JSON.parse(jsonList) as EnvDaemonConfig[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch (error) {
        console.warn("[DaemonRegistry] Failed to parse EXPO_PUBLIC_DAEMONS:", error);
      }
    }

    // Fallback: single host via EXPO_PUBLIC_DAEMON_WS_URL (+ optional label/rest URL)
    const singleWsUrl = process.env.EXPO_PUBLIC_DAEMON_WS_URL;
    if (singleWsUrl) {
      return [
        {
          label: process.env.EXPO_PUBLIC_DAEMON_LABEL,
          wsUrl: singleWsUrl,
          restUrl: process.env.EXPO_PUBLIC_DAEMON_REST_URL,
        },
      ];
    }

    return [];
  })();

  const timestamp = new Date().toISOString();
  return envDaemons
    .filter((entry) => typeof entry?.wsUrl === "string" && entry.wsUrl.trim().length > 0)
    .map((entry) => ({
      id: generateDaemonId(),
      label: entry.label?.trim() || deriveLabelFromUrl(entry.wsUrl),
      wsUrl: entry.wsUrl.trim(),
      restUrl: entry.restUrl ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: null,
    }));
}

async function loadDaemonRegistryFromStorage(): Promise<DaemonProfile[]> {
  try {
    const stored = await AsyncStorage.getItem(REGISTRY_STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored) as DaemonProfile[];
    }

    const legacy = await AsyncStorage.getItem(LEGACY_SETTINGS_KEY);
    if (legacy) {
      const legacyParsed = JSON.parse(legacy) as Record<string, unknown>;
      const legacyUrl = typeof legacyParsed.serverUrl === "string" ? legacyParsed.serverUrl : null;
      if (legacyUrl) {
        const migrated = [createProfile("Primary Host", legacyUrl)];
        await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    }

    const envDefaults = parseEnvDaemonDefaults();
    if (envDefaults.length > 0) {
      await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(envDefaults));
      return envDefaults;
    }

    const fallback = [createProfile("Local Host", FALLBACK_DAEMON_URL)];
    await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(fallback));
    return fallback;
  } catch (error) {
    console.error("[DaemonRegistry] Failed to load daemon registry", error);
    throw error;
  }
}
