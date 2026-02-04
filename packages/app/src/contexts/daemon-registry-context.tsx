import { createContext, useCallback, useContext } from "react";
import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  buildDaemonWebSocketUrl,
  decodeOfferFragmentPayload,
  deriveLabelFromEndpoint,
  extractHostPortFromWebSocketUrl,
  normalizeHostPort,
} from "@/utils/daemon-endpoints";
import {
  ConnectionOfferV1Schema,
  type ConnectionOfferV1,
} from "@server/shared/connection-offer";

const REGISTRY_STORAGE_KEY = "@paseo:daemon-registry";
const LEGACY_SETTINGS_KEY = "@paseo:settings";
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

interface DaemonRegistryContextValue {
  daemons: HostProfile[];
  isLoading: boolean;
  error: unknown | null;
  addDaemon: (input: CreateHostInput) => Promise<HostProfile>;
  updateDaemon: (id: string, updates: UpdateHostInput) => Promise<void>;
  removeDaemon: (id: string) => Promise<void>;
  upsertDaemonFromOffer: (offer: ConnectionOfferV1) => Promise<HostProfile>;
  upsertDaemonFromOfferUrl: (offerUrlOrFragment: string) => Promise<HostProfile>;
  adoptDaemonServerId: (currentId: string, serverId: string) => Promise<string>;
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

  const adoptDaemonServerId = useCallback(
    async (currentId: string, serverId: string) => {
      const trimmed = serverId.trim();
      if (!trimmed) {
        throw new Error("serverId is required");
      }
      if (currentId === trimmed) {
        return trimmed;
      }

      const existing = readDaemons();
      const now = new Date().toISOString();
      const idx = existing.findIndex((daemon) => daemon.id === currentId);
      if (idx === -1) {
        return trimmed;
      }

      const current = existing[idx];
      const otherIdx = existing.findIndex((daemon) => daemon.id === trimmed);

      const addLegacyId = (metadata: Record<string, unknown> | null | undefined, legacyId: string) => {
        const prev = (metadata ?? {}) as Record<string, unknown>;
        const legacyIdsRaw = prev.legacyIds;
        const legacyIds = Array.isArray(legacyIdsRaw)
          ? legacyIdsRaw.filter((value) => typeof value === "string")
          : [];
        if (!legacyIds.includes(legacyId)) {
          legacyIds.push(legacyId);
        }
        return { ...prev, legacyIds };
      };

      // Merge into existing canonical entry if it exists.
      if (otherIdx !== -1) {
        const canonical = existing[otherIdx];
        const merged: HostProfile = {
          ...canonical,
          label: canonical.label?.trim() ? canonical.label : current.label,
          endpoints: Array.from(new Set([...(canonical.endpoints ?? []), ...(current.endpoints ?? [])])),
          daemonPublicKeyB64: canonical.daemonPublicKeyB64 ?? current.daemonPublicKeyB64,
          relay: canonical.relay ?? current.relay ?? null,
          createdAt: canonical.createdAt ?? current.createdAt,
          updatedAt: now,
          metadata: addLegacyId(canonical.metadata, currentId),
        };
        const next = existing.filter((daemon) => daemon.id !== currentId);
        next[otherIdx > idx ? otherIdx - 1 : otherIdx] = merged;
        await persist(next);
        return trimmed;
      }

      const updated: HostProfile = {
        ...current,
        id: trimmed,
        updatedAt: now,
        metadata: addLegacyId(current.metadata, currentId),
      };

      const next = [...existing];
      next[idx] = updated;
      await persist(next);
      return trimmed;
    },
    [persist, readDaemons]
  );

  const upsertDaemonFromOffer = useCallback(
    async (offer: ConnectionOfferV1) => {
      const existing = readDaemons();
      const now = new Date().toISOString();
      const normalizedEndpoints = offer.endpoints.map((endpoint) => normalizeHostPort(endpoint));
      let relayEndpoint: string | null = null;
      if (offer.relay?.endpoint) {
        relayEndpoint = normalizeHostPort(offer.relay.endpoint);
      } else if (offer.relay === undefined && normalizedEndpoints.length > 0) {
        // Back-compat: older offers encoded relay endpoint as the last entry.
        relayEndpoint = normalizedEndpoints[normalizedEndpoints.length - 1];
      }
      const relay = relayEndpoint
        ? { endpoint: relayEndpoint, sessionId: offer.sessionId }
        : null;

      const matchIndex = existing.findIndex((daemon) => daemon.daemonPublicKeyB64 === offer.daemonPublicKeyB64);
      if (matchIndex !== -1) {
        const updated: HostProfile = {
          ...existing[matchIndex],
          daemonPublicKeyB64: offer.daemonPublicKeyB64,
          endpoints: normalizedEndpoints,
          relay,
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
        relay,
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
    adoptDaemonServerId,
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

const LOCAL_DAEMON_LABEL = "Local";

function getLocalDaemonEndpoint(): string | null {
  const endpoint = process.env.EXPO_PUBLIC_LOCAL_DAEMON;
  if (!endpoint || endpoint.trim().length === 0) {
    return null;
  }
  return endpoint.trim();
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

function upsertLocalDaemon(hosts: HostProfile[], localEndpoint: string): HostProfile[] {
  const result = [...hosts];
  const now = new Date().toISOString();
  const existingIndex = result.findIndex((host) => host.label === LOCAL_DAEMON_LABEL);

  if (existingIndex !== -1) {
    result[existingIndex] = {
      ...result[existingIndex],
      endpoints: [normalizeHostPort(localEndpoint)],
      updatedAt: now,
    };
  } else {
    result.unshift({
      id: generateDaemonId(),
      label: LOCAL_DAEMON_LABEL,
      endpoints: [normalizeHostPort(localEndpoint)],
      createdAt: now,
      updatedAt: now,
      metadata: null,
    });
  }

  return result;
}

async function loadDaemonRegistryFromStorage(): Promise<HostProfile[]> {
  try {
    const localEndpoint = getLocalDaemonEndpoint();

    const stored = await AsyncStorage.getItem(REGISTRY_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) {
        if (parsed.length === 0 && !localEndpoint) {
          return [];
        }

        const hasLegacy = parsed.some((entry) => isLegacyDaemonProfile(entry));
        const hasNew = parsed.some((entry) => isHostProfile(entry));

        if (hasNew && !hasLegacy) {
          const hosts = parsed as HostProfile[];
          if (localEndpoint) {
            const merged = upsertLocalDaemon(hosts, localEndpoint);
            await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(merged));
            return merged;
          }
          return hosts;
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
          const merged = localEndpoint ? upsertLocalDaemon(migrated, localEndpoint) : migrated;
          await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(merged));
          return merged;
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
        const merged = localEndpoint ? upsertLocalDaemon(migrated, localEndpoint) : migrated;
        await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(merged));
        return merged;
      }
    }

    if (localEndpoint) {
      const hosts = upsertLocalDaemon([], localEndpoint);
      await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(hosts));
      return hosts;
    }

    return [];
  } catch (error) {
    console.error("[DaemonRegistry] Failed to load daemon registry", error);
    throw error;
  }
}

export function buildDirectDaemonWsUrl(profile: HostProfile): string {
  const endpoint = profile.endpoints[0];
  if (!endpoint) {
    throw new Error("Host profile has no endpoints");
  }
  return buildDaemonWebSocketUrl(endpoint);
}

export function resolveCanonicalDaemonId(daemons: HostProfile[], id: string): string | null {
  const direct = daemons.find((daemon) => daemon.id === id);
  if (direct) return direct.id;

  for (const daemon of daemons) {
    const legacyIds = (daemon.metadata as any)?.legacyIds;
    if (Array.isArray(legacyIds) && legacyIds.some((value) => value === id)) {
      return daemon.id;
    }
  }
  return null;
}
