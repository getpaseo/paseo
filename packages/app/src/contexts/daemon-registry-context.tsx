import { createContext, useCallback, useContext } from "react";
import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  decodeOfferFragmentPayload,
  deriveLabelFromEndpoint,
  normalizeHostPort,
} from "@/utils/daemon-endpoints";
import {
  ConnectionOfferSchema,
  type ConnectionOffer,
} from "@server/shared/connection-offer";

const REGISTRY_STORAGE_KEY = "@paseo:daemon-registry";
const DAEMON_REGISTRY_QUERY_KEY = ["daemon-registry"];

export type DirectHostConnection = {
  id: string;
  type: "direct";
  endpoint: string; // host:port
};

export type RelayHostConnection = {
  id: string;
  type: "relay";
  relayEndpoint: string; // host:port
  daemonPublicKeyB64: string;
};

export type HostConnection = DirectHostConnection | RelayHostConnection;

export type HostProfile = {
  serverId: string;
  label: string;
  connections: HostConnection[];
  preferredConnectionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpdateHostInput = Partial<Omit<HostProfile, "serverId" | "createdAt">>;

interface DaemonRegistryContextValue {
  daemons: HostProfile[];
  isLoading: boolean;
  error: unknown | null;
  upsertDirectConnection: (input: {
    serverId: string;
    endpoint: string;
    label?: string;
  }) => Promise<HostProfile>;
  upsertRelayConnection: (input: {
    serverId: string;
    relayEndpoint: string;
    daemonPublicKeyB64: string;
    label?: string;
  }) => Promise<HostProfile>;
  updateHost: (serverId: string, updates: UpdateHostInput) => Promise<void>;
  removeHost: (serverId: string) => Promise<void>;
  removeConnection: (serverId: string, connectionId: string) => Promise<void>;
  upsertDaemonFromOffer: (offer: ConnectionOffer) => Promise<HostProfile>;
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

  const updateHost = useCallback(
    async (serverId: string, updates: UpdateHostInput) => {
      const next = readDaemons().map((daemon) =>
        daemon.serverId === serverId
          ? {
              ...daemon,
              ...updates,
              updatedAt: new Date().toISOString(),
            }
          : daemon
      );
      await persist(next);
    },
    [persist, readDaemons]
  );

  const removeHost = useCallback(
    async (serverId: string) => {
      const remaining = readDaemons().filter((daemon) => daemon.serverId !== serverId);
      await persist(remaining);
    },
    [persist, readDaemons]
  );

  const removeConnection = useCallback(
    async (serverId: string, connectionId: string) => {
      const now = new Date().toISOString();
      const next = readDaemons()
        .map((daemon) => {
        if (daemon.serverId !== serverId) return daemon;
        const remaining = daemon.connections.filter((conn) => conn.id !== connectionId);
        if (remaining.length === 0) {
          return null;
        }
        const preferred =
          daemon.preferredConnectionId === connectionId
            ? remaining[0]?.id ?? null
            : daemon.preferredConnectionId;
        return {
          ...daemon,
          connections: remaining,
          preferredConnectionId: preferred,
          updatedAt: now,
        } satisfies HostProfile;
      })
        .filter((entry): entry is HostProfile => entry !== null);
      await persist(next);
    },
    [persist, readDaemons]
  );

  const upsertHostConnection = useCallback(
    async (
      input: {
        serverId: string;
        label?: string;
      } & (
        | { connection: DirectHostConnection }
        | { connection: RelayHostConnection }
      )
    ) => {
      const existing = readDaemons();
      const now = new Date().toISOString();
      const serverId = input.serverId.trim();
      if (!serverId) {
        throw new Error("serverId is required");
      }

      const labelTrimmed = input.label?.trim() ?? "";
      const derivedLabel =
        labelTrimmed ||
        (input.connection.type === "direct"
          ? deriveLabelFromEndpoint(input.connection.endpoint)
          : serverId);

      const idx = existing.findIndex((d) => d.serverId === serverId);
      if (idx === -1) {
        const profile: HostProfile = {
          serverId,
          label: derivedLabel,
          connections: [input.connection],
          preferredConnectionId: input.connection.id,
          createdAt: now,
          updatedAt: now,
        };
        const next = [...existing, profile];
        await persist(next);
        return profile;
      }

      const prev = existing[idx]!;
      const connectionIdx = prev.connections.findIndex((c) => c.id === input.connection.id);
      const nextConnections =
        connectionIdx === -1
          ? [...prev.connections, input.connection]
          : prev.connections.map((c, i) => (i === connectionIdx ? input.connection : c));

      const nextProfile: HostProfile = {
        ...prev,
        label: labelTrimmed ? labelTrimmed : prev.label,
        connections: nextConnections,
        preferredConnectionId: prev.preferredConnectionId ?? input.connection.id,
        updatedAt: now,
      };

      const next = [...existing];
      next[idx] = nextProfile;
      await persist(next);
      return nextProfile;
    },
    [persist, readDaemons]
  );

  const upsertDirectConnection = useCallback(
    async (input: { serverId: string; endpoint: string; label?: string }) => {
      const endpoint = normalizeHostPort(input.endpoint);
      const connection: DirectHostConnection = {
        id: `direct:${endpoint}`,
        type: "direct",
        endpoint,
      };
      return upsertHostConnection({
        serverId: input.serverId,
        label: input.label,
        connection,
      });
    },
    [upsertHostConnection]
  );

  const upsertRelayConnection = useCallback(
    async (input: { serverId: string; relayEndpoint: string; daemonPublicKeyB64: string; label?: string }) => {
      const relayEndpoint = normalizeHostPort(input.relayEndpoint);
      const daemonPublicKeyB64 = input.daemonPublicKeyB64.trim();
      if (!daemonPublicKeyB64) {
        throw new Error("daemonPublicKeyB64 is required");
      }
      const connection: RelayHostConnection = {
        id: `relay:${relayEndpoint}`,
        type: "relay",
        relayEndpoint,
        daemonPublicKeyB64,
      };
      return upsertHostConnection({
        serverId: input.serverId,
        label: input.label,
        connection,
      });
    },
    [upsertHostConnection]
  );

  const upsertDaemonFromOffer = useCallback(
    async (offer: ConnectionOffer) => {
      return upsertRelayConnection({
        serverId: offer.serverId,
        relayEndpoint: offer.relay.endpoint,
        daemonPublicKeyB64: offer.daemonPublicKeyB64,
        label: offer.serverId,
      });
    },
    [upsertRelayConnection]
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
      const offer = ConnectionOfferSchema.parse(payload);
      return upsertDaemonFromOffer(offer);
    },
    [upsertDaemonFromOffer]
  );

  const value: DaemonRegistryContextValue = {
    daemons,
    isLoading: isPending,
    error: error ?? null,
    upsertDirectConnection,
    upsertRelayConnection,
    updateHost,
    removeHost,
    removeConnection,
    upsertDaemonFromOffer,
    upsertDaemonFromOfferUrl,
  };

  return (
    <DaemonRegistryContext.Provider value={value}>
      {children}
    </DaemonRegistryContext.Provider>
  );
}

type LegacyHostProfileV1 = {
  id: string;
  label: string;
  endpoints?: unknown;
  daemonPublicKeyB64?: unknown;
  relay?: unknown;
  createdAt: string;
  updatedAt: string;
};

function isHostProfileV2(value: unknown): value is HostProfile {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.serverId === "string" &&
    typeof obj.label === "string" &&
    Array.isArray(obj.connections) &&
    typeof obj.createdAt === "string" &&
    typeof obj.updatedAt === "string"
  );
}

async function loadDaemonRegistryFromStorage(): Promise<HostProfile[]> {
  try {
    const stored = await AsyncStorage.getItem(REGISTRY_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) {
        const v2 = parsed.filter((entry) => isHostProfileV2(entry)) as HostProfile[];
        if (v2.length === parsed.length) {
          return v2;
        }

        // Hard migration from the previous in-repo schema (v1 HostProfile with `id/endpoints/relay`).
        const migrated: HostProfile[] = parsed
          .map((entry): HostProfile | null => {
            if (!entry || typeof entry !== "object") return null;
            const obj = entry as LegacyHostProfileV1;
            if (typeof obj.id !== "string" || typeof obj.label !== "string") return null;

            // Only keep stable daemon ids; discard transient entries to avoid confusing host selection.
            if (!obj.id.startsWith("srv_")) return null;

            const now = new Date().toISOString();
            const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : now;
            const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : now;

            const connections: HostConnection[] = [];

            if (Array.isArray(obj.endpoints)) {
              for (const endpointRaw of obj.endpoints) {
                try {
                  const endpoint = normalizeHostPort(String(endpointRaw));
                  connections.push({ id: `direct:${endpoint}`, type: "direct", endpoint });
                } catch {
                  // ignore invalid endpoint
                }
              }
            }

            const relayEndpointRaw =
              obj.relay && typeof (obj.relay as any)?.endpoint === "string"
                ? String((obj.relay as any).endpoint)
                : null;
            const daemonPublicKeyB64 =
              typeof obj.daemonPublicKeyB64 === "string" ? obj.daemonPublicKeyB64.trim() : "";

            if (relayEndpointRaw && daemonPublicKeyB64) {
              try {
                const relayEndpoint = normalizeHostPort(relayEndpointRaw);
                connections.push({
                  id: `relay:${relayEndpoint}`,
                  type: "relay",
                  relayEndpoint,
                  daemonPublicKeyB64,
                });
              } catch {
                // ignore invalid relay endpoint
              }
            }

            if (connections.length === 0) return null;

            const preferredConnectionId: string | null = connections[0]?.id ?? null;

            return {
              serverId: obj.id,
              label: obj.label,
              connections,
              preferredConnectionId,
              createdAt,
              updatedAt,
            };
          })
          .filter((entry): entry is HostProfile => entry !== null);

        await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    }

    return [];
  } catch (error) {
    console.error("[DaemonRegistry] Failed to load daemon registry", error);
    throw error;
  }
}
