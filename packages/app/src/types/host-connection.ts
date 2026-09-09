import {
  normalizeHostPort,
  normalizeLoopbackToLocalhost,
} from "@getpaseo/protocol/daemon-endpoints";
import {
  DirectTcpHostConnectionSchema,
  type DirectTcpHostConnection,
} from "@getpaseo/protocol/host-connection-schema";
import {
  DEFAULT_SSH_DAEMON_PORT,
  validatePort,
  validateSshHost,
} from "@getpaseo/protocol/ssh-transport";
import {
  type HostAppearance,
  defaultHostAppearance,
  HostAppearanceSchema,
} from "@/hosts/appearance";
import { z } from "zod";

export { DirectTcpHostConnectionSchema, type DirectTcpHostConnection };

export interface DirectSocketHostConnection {
  id: string;
  type: "directSocket";
  path: string;
}

export interface DirectPipeHostConnection {
  id: string;
  type: "directPipe";
  path: string;
}

export interface RemoteSshHostConnection {
  id: string;
  type: "remoteSsh";
  host: string;
  sshPort?: number;
  daemonPort?: number;
}

export interface RelayHostConnection {
  id: string;
  type: "relay";
  relayEndpoint: string;
  useTls?: boolean;
  daemonPublicKeyB64: string;
}

export type HostConnection =
  | DirectTcpHostConnection
  | DirectSocketHostConnection
  | DirectPipeHostConnection
  | RemoteSshHostConnection
  | RelayHostConnection;

export type HostLifecycle = Record<string, never>;

export interface HostProfile {
  serverId: string;
  label: string;
  appearance: HostAppearance;
  lifecycle: HostLifecycle;
  connections: HostConnection[];
  preferredConnectionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function defaultLifecycle(): HostLifecycle {
  return {};
}

export function normalizeHostLabel(value: string | null | undefined, serverId: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : serverId;
}

export function orderHostsLocalFirst<T extends { serverId: string }>(
  hosts: T[],
  localServerId: string | null,
): T[] {
  if (!localServerId) {
    return hosts;
  }
  const localIndex = hosts.findIndex((host) => host.serverId === localServerId);
  if (localIndex <= 0) {
    return hosts;
  }
  const ordered = hosts.slice();
  const [local] = ordered.splice(localIndex, 1);
  if (local) {
    ordered.unshift(local);
  }
  return ordered;
}

/**
 * Resolves which host a settings host section should target: the picker
 * selection, else the local daemon, else the first connected host.
 *
 * Only a serverId that names a currently connected host is used. Both the
 * selection and the local daemon can name a host that isn't connected (a stale
 * selection, or a local daemon whose id persists in storage while it's stopped);
 * using one would resolve the section to an unknown id and render "host not found".
 */
export function resolveActiveHostServerId(params: {
  selectedServerId: string | null;
  localServerId: string | null;
  hosts: readonly { serverId: string }[];
  orderedHosts: readonly { serverId: string }[];
}): string | null {
  const { selectedServerId, localServerId, hosts, orderedHosts } = params;
  const connected = (serverId: string | null): string | null =>
    serverId && hosts.some((host) => host.serverId === serverId) ? serverId : null;
  return (
    connected(selectedServerId) ?? connected(localServerId) ?? orderedHosts[0]?.serverId ?? null
  );
}

function hostConnectionEquals(left: HostConnection, right: HostConnection): boolean {
  if (left.type !== right.type || left.id !== right.id) {
    return false;
  }

  if (left.type === "directTcp" && right.type === "directTcp") {
    return (
      left.endpoint === right.endpoint &&
      (left.useTls ?? false) === (right.useTls ?? false) &&
      left.password === right.password
    );
  }
  if (left.type === "directSocket" && right.type === "directSocket") {
    return left.path === right.path;
  }
  if (left.type === "directPipe" && right.type === "directPipe") {
    return left.path === right.path;
  }
  if (left.type === "remoteSsh" && right.type === "remoteSsh") {
    return remoteSshConnectionEquals(left, right);
  }
  if (left.type === "relay" && right.type === "relay") {
    return (
      left.relayEndpoint === right.relayEndpoint &&
      left.useTls === right.useTls &&
      left.daemonPublicKeyB64 === right.daemonPublicKeyB64
    );
  }

  return false;
}

function remoteSshConnectionEquals(
  left: RemoteSshHostConnection,
  right: RemoteSshHostConnection,
): boolean {
  return (
    left.host === right.host &&
    left.sshPort === right.sshPort &&
    left.daemonPort === right.daemonPort
  );
}

function hostLifecycleEquals(left: HostLifecycle, right: HostLifecycle): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function upsertHostConnectionById(
  connections: HostConnection[],
  connection: HostConnection,
): HostConnection[] {
  const next: HostConnection[] = [];
  let replaced = false;
  for (const existing of connections) {
    if (existing.id !== connection.id) {
      next.push(existing);
      continue;
    }

    if (replaced) continue;
    next.push(connection);
    replaced = true;
  }
  if (!replaced) next.push(connection);
  return next;
}

export function upsertHostConnectionInProfiles(input: {
  profiles: HostProfile[];
  serverId: string;
  label?: string;
  connection: HostConnection;
  now?: string;
}): HostProfile[] {
  const serverId = input.serverId.trim();
  if (!serverId) {
    throw new Error("serverId is required");
  }

  const now = input.now ?? new Date().toISOString();
  const labelTrimmed = input.label?.trim() ?? "";
  const derivedLabel = labelTrimmed || serverId;
  const existing = input.profiles;
  const matchingIndexes = existing.reduce<number[]>((matches, daemon, index) => {
    if (
      daemon.serverId === serverId ||
      daemon.connections.some((connection) => hostConnectionEquals(connection, input.connection))
    ) {
      matches.push(index);
    }
    return matches;
  }, []);

  if (matchingIndexes.length === 0) {
    const profile: HostProfile = {
      serverId,
      label: derivedLabel,
      appearance: defaultHostAppearance(),
      lifecycle: defaultLifecycle(),
      connections: [input.connection],
      preferredConnectionId: input.connection.id,
      createdAt: now,
      updatedAt: now,
    };
    return [...existing, profile];
  }

  const matchedProfiles = matchingIndexes.map((index) => existing[index]);
  const prev = matchedProfiles.find((daemon) => daemon.serverId === serverId) ?? matchedProfiles[0];
  const nextConnections = upsertHostConnectionById(
    matchedProfiles.flatMap((daemon) => daemon.connections),
    input.connection,
  );
  const nextLifecycle = prev.lifecycle;
  const nextLabel = prev.label === prev.serverId ? derivedLabel : prev.label;
  const nextPreferredConnectionId =
    prev.preferredConnectionId &&
    nextConnections.some((connection) => connection.id === prev.preferredConnectionId)
      ? prev.preferredConnectionId
      : input.connection.id;
  const nextCreatedAt = matchedProfiles.reduce(
    (earliest, daemon) => (daemon.createdAt < earliest ? daemon.createdAt : earliest),
    prev.createdAt,
  );
  const changed =
    matchingIndexes.length > 1 ||
    prev.serverId !== serverId ||
    nextCreatedAt !== prev.createdAt ||
    nextLabel !== prev.label ||
    nextPreferredConnectionId !== prev.preferredConnectionId ||
    !hostLifecycleEquals(prev.lifecycle, nextLifecycle) ||
    nextConnections.length !== prev.connections.length ||
    nextConnections.some((connection, index) => {
      const previousConnection = prev.connections[index];
      return !previousConnection || !hostConnectionEquals(connection, previousConnection);
    });

  if (!changed) {
    return existing;
  }

  const nextProfile: HostProfile = {
    ...prev,
    serverId,
    label: nextLabel,
    lifecycle: nextLifecycle,
    connections: nextConnections,
    preferredConnectionId: nextPreferredConnectionId,
    createdAt: nextCreatedAt,
    updatedAt: now,
  };

  const firstIndex = matchingIndexes[0];
  const matchingIndexSet = new Set(matchingIndexes);
  const next = existing.filter((_daemon, index) => !matchingIndexSet.has(index));
  next.splice(firstIndex, 0, nextProfile);
  return next;
}

export function connectionFromListen(listen: string): HostConnection | null {
  const normalizedListen = listen.trim();
  if (!normalizedListen) {
    return null;
  }

  if (normalizedListen.startsWith("pipe://")) {
    const path = normalizedListen.slice("pipe://".length).trim();
    return path ? { id: `pipe:${path}`, type: "directPipe", path } : null;
  }

  if (normalizedListen.startsWith("unix://")) {
    const path = normalizedListen.slice("unix://".length).trim();
    return path ? { id: `socket:${path}`, type: "directSocket", path } : null;
  }

  if (normalizedListen.startsWith("\\\\.\\pipe\\")) {
    return {
      id: `pipe:${normalizedListen}`,
      type: "directPipe",
      path: normalizedListen,
    };
  }

  if (normalizedListen.startsWith("/")) {
    return {
      id: `socket:${normalizedListen}`,
      type: "directSocket",
      path: normalizedListen,
    };
  }

  try {
    const endpoint = normalizeLoopbackToLocalhost(normalizeHostPort(normalizedListen));
    return {
      id: `direct:${endpoint}`,
      type: "directTcp",
      endpoint,
    };
  } catch {
    return null;
  }
}

export function createRemoteSshHostConnection(input: {
  host: string;
  sshPort?: number;
  daemonPort?: number;
}): RemoteSshHostConnection {
  const host = validateSshHost(input.host);
  const sshPort = input.sshPort === undefined ? undefined : validatePort(input.sshPort, "SSH port");

  const daemonPort =
    input.daemonPort === undefined || input.daemonPort === DEFAULT_SSH_DAEMON_PORT
      ? undefined
      : validatePort(input.daemonPort, "Daemon port");

  const id = [
    "ssh",
    encodeURIComponent(host),
    sshPort === undefined ? "" : String(sshPort),
    daemonPort === undefined ? "" : String(daemonPort),
  ].join(":");

  return {
    id,
    type: "remoteSsh",
    host,
    ...(sshPort !== undefined ? { sshPort } : {}),
    ...(daemonPort !== undefined ? { daemonPort } : {}),
  };
}

const StoredHostConnectionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    id: z.string().optional(),
    type: z.literal("directTcp"),
    endpoint: z.string(),
    useTls: z.boolean().optional(),
    password: z.string().optional(),
  }),
  z.strictObject({
    id: z.string().optional(),
    type: z.literal("directSocket"),
    path: z.string(),
  }),
  z.strictObject({
    id: z.string().optional(),
    type: z.literal("directPipe"),
    path: z.string(),
  }),
  z.strictObject({
    id: z.string().optional(),
    type: z.literal("remoteSsh"),
    host: z.string(),
    sshPort: z.number().optional(),
    daemonPort: z.number().optional(),
  }),
  z.strictObject({
    id: z.string().optional(),
    type: z.literal("relay"),
    relayEndpoint: z.string(),
    useTls: z.boolean().optional(),
    daemonPublicKeyB64: z.string(),
  }),
]);
const StoredHostProfileSchema = z.strictObject({
  serverId: z.string().trim().min(1),
  label: z.string().optional(),
  appearance: HostAppearanceSchema.optional(),
  lifecycle: z.strictObject({}).optional(),
  connections: z.array(StoredHostConnectionSchema).min(1),
  preferredConnectionId: z.string().nullable().optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
});
export const StoredHostRegistrySchema = z.array(StoredHostProfileSchema);
type StoredHostConnection = z.infer<typeof StoredHostConnectionSchema>;

function normalizeStoredConnection(connection: StoredHostConnection): HostConnection | null {
  if (connection.type === "directTcp") {
    try {
      const endpoint = normalizeLoopbackToLocalhost(normalizeHostPort(connection.endpoint));
      return DirectTcpHostConnectionSchema.parse({
        id: `direct:${endpoint}`,
        type: "directTcp",
        endpoint,
        useTls: connection.useTls,
        ...(connection.password !== undefined ? { password: connection.password } : {}),
      });
    } catch {
      return null;
    }
  }
  if (connection.type === "directSocket") {
    const path = connection.path.trim();
    return path ? { id: `socket:${path}`, type: "directSocket", path } : null;
  }
  if (connection.type === "directPipe") {
    const path = connection.path.trim();
    return path ? { id: `pipe:${path}`, type: "directPipe", path } : null;
  }
  if (connection.type === "remoteSsh") {
    try {
      return createRemoteSshHostConnection({
        host: connection.host,
        ...(connection.sshPort !== undefined ? { sshPort: connection.sshPort } : {}),
        ...(connection.daemonPort !== undefined ? { daemonPort: connection.daemonPort } : {}),
      });
    } catch {
      return null;
    }
  }
  if (connection.type === "relay") {
    try {
      const relayEndpoint = normalizeHostPort(connection.relayEndpoint);
      const daemonPublicKeyB64 = connection.daemonPublicKeyB64.trim();
      if (!daemonPublicKeyB64) return null;
      const useTls = connection.useTls;
      return {
        id: useTls === true ? `relay:wss:${relayEndpoint}` : `relay:${relayEndpoint}`,
        type: "relay",
        relayEndpoint,
        ...(useTls !== undefined ? { useTls } : {}),
        daemonPublicKeyB64,
      };
    } catch {
      return null;
    }
  }

  return null;
}

export function normalizeStoredHostProfile(entry: unknown): HostProfile | null {
  const result = StoredHostProfileSchema.safeParse(entry);
  if (!result.success) {
    return null;
  }
  const record = result.data;
  const serverId = record.serverId;

  const connections = record.connections
    .map((connection) => normalizeStoredConnection(connection))
    .filter((connection): connection is HostConnection => connection !== null);
  if (connections.length === 0) {
    return null;
  }

  const now = new Date().toISOString();
  const label = normalizeHostLabel(record.label, serverId);
  const preferredConnectionId =
    record.preferredConnectionId !== null &&
    record.preferredConnectionId !== undefined &&
    connections.some((connection) => connection.id === record.preferredConnectionId)
      ? record.preferredConnectionId
      : (connections[0]?.id ?? null);

  return {
    serverId,
    label,
    appearance: record.appearance ?? defaultHostAppearance(),
    lifecycle: defaultLifecycle(),
    connections,
    preferredConnectionId,
    createdAt: record.createdAt ?? now,
    updatedAt: record.updatedAt ?? now,
  };
}

export function hostHasConnection(host: HostProfile, connection: HostConnection): boolean {
  return host.connections.some((existing) => hostConnectionEquals(existing, connection));
}

export function registryHasConnection(hosts: HostProfile[], connection: HostConnection): boolean {
  return hosts.some((host) => hostHasConnection(host, connection));
}
