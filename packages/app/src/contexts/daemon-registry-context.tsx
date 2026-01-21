import { createContext, useCallback, useContext } from "react";
import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  buildDaemonWebSocketUrl,
  decodeOfferFragmentPayload,
  deriveLabelFromEndpoint,
  extractHostPortFromWebSocketUrl,
  normalizeHostPort,
} from "@/utils/daemon-endpoints";

const REGISTRY_STORAGE_KEY = "@paseo:daemon-registry";
const LEGACY_SETTINGS_KEY = "@paseo:settings";
const FALLBACK_DAEMON_ENDPOINT = "localhost:6767";
const DEFAULT_HOSTS: Array<{ label: string; endpoint: string }> = [
  { label: "localhost", endpoint: "localhost:6767" },
];
const DAEMON_REGISTRY_QUERY_KEY = ["daemon-registry"];

export type HostRelayConfig = {
  endpoint: string;
  sessionId: string;
};

export type HostProfile = {
  id: string;
  label: string;
  endpoints: string[];
  daemonPublicKeyB64?: string;
  relay?: HostRelayConfig | null;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown> | null;
};

// Backward compatibility with older imports.
export type DaemonProfile = HostProfile;

type CreateHostInput = {
  label: string;
  endpoints: string[];
};

type UpdateHostInput = Partial<Omit<HostProfile, "id" | "createdAt">>;

const ConnectionOfferV1Schema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  endpoints: z.array(z.string().min(1)).min(1),
  daemonPublicKeyB64: z.string().min(1),
});

export type ConnectionOfferV1 = z.infer<typeof ConnectionOfferV1Schema>;

interface DaemonRegistryContextValue {
  daemons: HostProfile[];
  isLoading: boolean;
  error: unknown | null;
  addDaemon: (input: CreateHostInput) => Promise<HostProfile>;
  updateDaemon: (id: string, updates: UpdateHostInput) => Promise<void>;
  removeDaemon: (id: string) => Promise<void>;
  upsertDaemonFromOffer: (offer: ConnectionOfferV1) => Promise<HostProfile>;
  upsertDaemonFromOfferUrl: (offerUrlOrFragment: string) => Promise<HostProfile>;
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
    async (profiles: HostProfile[]) => {
      queryClient.setQueryData<HostProfile[]>(DAEMON_REGISTRY_QUERY_KEY, profiles);
      await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(profiles));
    },
    [queryClient]
  );

  const readDaemons = useCallback(() => {
    return queryClient.getQueryData<HostProfile[]>(DAEMON_REGISTRY_QUERY_KEY) ?? daemons;
  }, [queryClient, daemons]);

  const addDaemon = useCallback(async (input: CreateHostInput) => {
    const existing = readDaemons();
    const timestamp = new Date().toISOString();
    const profile: HostProfile = {
      id: generateDaemonId(),
      label: input.label.trim() || deriveLabelFromEndpoint(input.endpoints[0] ?? ""),
      endpoints: input.endpoints.map((endpoint) => normalizeHostPort(endpoint)),
      daemonPublicKeyB64: undefined,
      relay: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: null,
    };

    const next = [...existing, profile];
    await persist(next);
    return profile;
  }, [persist, readDaemons]);

  const updateDaemon = useCallback(async (id: string, updates: UpdateHostInput) => {
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
    await persist(remaining);
  }, [persist, readDaemons]);

  const upsertDaemonFromOffer = useCallback(
    async (offer: ConnectionOfferV1) => {
      const existing = readDaemons();
      const now = new Date().toISOString();
      const normalizedEndpoints = offer.endpoints.map((endpoint) => normalizeHostPort(endpoint));
      const relayEndpoint = normalizedEndpoints[normalizedEndpoints.length - 1];

      const matchIndex = existing.findIndex((daemon) => daemon.daemonPublicKeyB64 === offer.daemonPublicKeyB64);
      if (matchIndex !== -1) {
        const updated: HostProfile = {
          ...existing[matchIndex],
          daemonPublicKeyB64: offer.daemonPublicKeyB64,
          endpoints: normalizedEndpoints,
          relay: { endpoint: relayEndpoint, sessionId: offer.sessionId },
          updatedAt: now,
        };
        const next = [...existing];
        next[matchIndex] = updated;
        await persist(next);
        return updated;
      }

      const profile: HostProfile = {
        id: generateDaemonId(),
        label: deriveLabelFromEndpoint(normalizedEndpoints[0] ?? "Unnamed Host"),
        endpoints: normalizedEndpoints,
        daemonPublicKeyB64: offer.daemonPublicKeyB64,
        relay: { endpoint: relayEndpoint, sessionId: offer.sessionId },
        createdAt: now,
        updatedAt: now,
        metadata: null,
      };

      const next = [...existing, profile];
      await persist(next);
      return profile;
    },
    [persist, readDaemons]
  );

  const upsertDaemonFromOfferUrl = useCallback(
    async (offerUrlOrFragment: string) => {
      const marker = "#offer=";
      const idx = offerUrlOrFragment.indexOf(marker);
      if (idx === -1) {
        throw new Error("Missing #offer= fragment");
      }
      const encoded = offerUrlOrFragment.slice(idx + marker.length).trim();
      if (!encoded) {
        throw new Error("Offer payload is empty");
      }
      const payload = decodeOfferFragmentPayload(encoded);
      const offer = ConnectionOfferV1Schema.parse(payload);
      return upsertDaemonFromOffer(offer);
    },
    [upsertDaemonFromOffer]
  );

  const value: DaemonRegistryContextValue = {
    daemons,
    isLoading: isPending,
    error: error ?? null,
    addDaemon,
    updateDaemon,
    removeDaemon,
    upsertDaemonFromOffer,
    upsertDaemonFromOfferUrl,
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

function createProfile(label: string, endpoint: string): HostProfile {
  const timestamp = new Date().toISOString();
  return {
    id: generateDaemonId(),
    label,
    endpoints: [normalizeHostPort(endpoint)],
    daemonPublicKeyB64: undefined,
    relay: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: null,
  };
}

type EnvDaemonConfig = {
  label?: string;
  endpoint?: string;
  wsUrl?: string;
};

function parseEnvDaemonDefaults(): HostProfile[] {
  const envDaemons = (() => {
    // Primary: allow a JSON array string like
    // EXPO_PUBLIC_DAEMONS='[{"label":"Host","endpoint":"10.0.0.1:6767"}]'
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
        },
      ];
    }

    return [];
  })();

  const timestamp = new Date().toISOString();
  return envDaemons
    .map((entry): HostProfile | null => {
      const endpoint = (() => {
        if (typeof entry.endpoint === "string" && entry.endpoint.trim().length > 0) {
          return entry.endpoint.trim();
        }
        if (typeof entry.wsUrl === "string" && entry.wsUrl.trim().length > 0) {
          try {
            return extractHostPortFromWebSocketUrl(entry.wsUrl.trim());
          } catch {
            return null;
          }
        }
        return null;
      })();

      if (!endpoint) return null;

      return {
        id: generateDaemonId(),
        label: entry.label?.trim() || deriveLabelFromEndpoint(endpoint),
        endpoints: [normalizeHostPort(endpoint)],
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: null,
      };
    })
    .filter((entry): entry is HostProfile => entry !== null);
}

type LegacyDaemonProfile = {
  id: string;
  label: string;
  wsUrl: string;
  restUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown> | null;
};

function isLegacyDaemonProfile(value: unknown): value is LegacyDaemonProfile {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.id === "string" && typeof obj.wsUrl === "string" && typeof obj.label === "string";
}

function isHostProfile(value: unknown): value is HostProfile {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.id === "string" && typeof obj.label === "string" && Array.isArray(obj.endpoints);
}

function migrateLegacyToHostProfile(legacy: LegacyDaemonProfile): HostProfile {
  const endpoint = extractHostPortFromWebSocketUrl(legacy.wsUrl);
  return {
    id: legacy.id,
    label: legacy.label,
    endpoints: [normalizeHostPort(endpoint)],
    daemonPublicKeyB64: undefined,
    relay: null,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    metadata: legacy.metadata ?? null,
  };
}

async function loadDaemonRegistryFromStorage(): Promise<HostProfile[]> {
  try {
    const stored = await AsyncStorage.getItem(REGISTRY_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          return [];
        }
        const hasLegacy = parsed.some((entry) => isLegacyDaemonProfile(entry));
        const hasNew = parsed.some((entry) => isHostProfile(entry));

        if (hasNew && !hasLegacy) {
          return parsed as HostProfile[];
        }

        const migrated = parsed
          .map((entry) => {
            if (isHostProfile(entry)) {
              const endpoints = entry.endpoints
                .map((endpoint) => {
                  try {
                    return normalizeHostPort(String(endpoint));
                  } catch {
                    return null;
                  }
                })
                .filter((endpoint): endpoint is string => endpoint !== null);
              if (endpoints.length === 0) {
                return null;
              }
              return { ...entry, endpoints } as HostProfile;
            }
            if (isLegacyDaemonProfile(entry)) {
              try {
                return migrateLegacyToHostProfile(entry);
              } catch {
                return null;
              }
            }
            return null;
          })
          .filter((entry): entry is HostProfile => entry !== null);

        if (migrated.length > 0) {
          await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(migrated));
          return migrated;
        }
      }
    }

    const legacy = await AsyncStorage.getItem(LEGACY_SETTINGS_KEY);
    if (legacy) {
      const legacyParsed = JSON.parse(legacy) as Record<string, unknown>;
      const legacyUrl = typeof legacyParsed.serverUrl === "string" ? legacyParsed.serverUrl : null;
      if (legacyUrl) {
        const endpoint = extractHostPortFromWebSocketUrl(legacyUrl);
        const migrated = [createProfile("Primary Host", endpoint)];
        await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    }

    const envDefaults = parseEnvDaemonDefaults();
    if (envDefaults.length > 0) {
      await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(envDefaults));
      return envDefaults;
    }

    const fallback = DEFAULT_HOSTS.length > 0
      ? DEFAULT_HOSTS.map((entry) => createProfile(entry.label, entry.endpoint))
      : [createProfile("Local Host", FALLBACK_DAEMON_ENDPOINT)];
    await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(fallback));
    return fallback;
  } catch (error) {
    console.error("[DaemonRegistry] Failed to load daemon registry", error);
    throw error;
  }
}

export function buildDirectDaemonWsUrl(profile: HostProfile): string {
  const endpoint = profile.endpoints[0] ?? FALLBACK_DAEMON_ENDPOINT;
  return buildDaemonWebSocketUrl(endpoint);
}
