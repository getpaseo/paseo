import { normalizeHostPort, normalizeLoopbackToLocalhost } from "@server/shared/daemon-endpoints";

export type DirectTcpHostConnection = {
  id: string;
  type: "directTcp";
  endpoint: string;
};

export type DirectSocketHostConnection = {
  id: string;
  type: "directSocket";
  path: string;
};

export type DirectPipeHostConnection = {
  id: string;
  type: "directPipe";
  path: string;
};

export type RelayHostConnection = {
  id: string;
  type: "relay";
  relayEndpoint: string;
  daemonPublicKeyB64: string;
};

export type HostConnection =
  | DirectTcpHostConnection
  | DirectSocketHostConnection
  | DirectPipeHostConnection
  | RelayHostConnection;

export type HostLifecycle = Record<string, never>;

export type HostProfile = {
  serverId: string;
  label: string;
  lifecycle: HostLifecycle;
  connections: HostConnection[];
  preferredConnectionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export function defaultLifecycle(): HostLifecycle {
  return {};
}

export function normalizeHostLabel(value: string | null | undefined, serverId: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : serverId;
}

function hostConnectionEquals(left: HostConnection, right: HostConnection): boolean {
  if (left.type !== right.type || left.id !== right.id) {
    return false;
  }

  if (left.type === "directTcp" && right.type === "directTcp") {
    return left.endpoint === right.endpoint;
  }
  if (left.type === "directSocket" && right.type === "directSocket") {
    return left.path === right.path;
  }
  if (left.type === "directPipe" && right.type === "directPipe") {
    return left.path === right.path;
  }
  if (left.type === "relay" && right.type === "relay") {
    return (
      left.relayEndpoint === right.relayEndpoint &&
      left.daemonPublicKeyB64 === right.daemonPublicKeyB64
    );
  }

  return false;
}

function hostLifecycleEquals(left: HostLifecycle, right: HostLifecycle): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dedupeHostConnections(connections: HostConnection[]): HostConnection[] {
  const next: HostConnection[] = [];
  for (const connection of connections) {
    if (next.some((existing) => hostConnectionEquals(existing, connection))) {
      continue;
    }
    next.push(connection);
  }
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
      lifecycle: defaultLifecycle(),
      connections: [input.connection],
      preferredConnectionId: input.connection.id,
      createdAt: now,
      updatedAt: now,
    };
    return [...existing, profile];
  }

  const matchedProfiles = matchingIndexes.map((index) => existing[index]!);
  const prev =
    matchedProfiles.find((daemon) => daemon.serverId === serverId) ?? matchedProfiles[0]!;
  const nextConnections = dedupeHostConnections([
    ...matchedProfiles.flatMap((daemon) => daemon.connections),
    input.connection,
  ]);
  const nextLifecycle = prev.lifecycle;
  const nextLabel = labelTrimmed || (prev.label === prev.serverId ? derivedLabel : prev.label);
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

  const firstIndex = matchingIndexes[0]!;
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

function normalizeStoredConnection(connection: unknown): HostConnection | null {
  if (!connection || typeof connection !== "object") {
    return null;
  }
  const record = connection as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  if (type === "directTcp") {
    try {
      const endpoint = normalizeLoopbackToLocalhost(
        normalizeHostPort(String(record.endpoint ?? "")),
      );
      return { id: `direct:${endpoint}`, type: "directTcp", endpoint };
    } catch {
      return null;
    }
  }
  if (type === "directSocket") {
    const path = String(record.path ?? "").trim();
    return path ? { id: `socket:${path}`, type: "directSocket", path } : null;
  }
  if (type === "directPipe") {
    const path = String(record.path ?? "").trim();
    return path ? { id: `pipe:${path}`, type: "directPipe", path } : null;
  }
  if (type === "relay") {
    try {
      const relayEndpoint = normalizeHostPort(String(record.relayEndpoint ?? ""));
      const daemonPublicKeyB64 = String(record.daemonPublicKeyB64 ?? "").trim();
      if (!daemonPublicKeyB64) return null;
      return {
        id: `relay:${relayEndpoint}`,
        type: "relay",
        relayEndpoint,
        daemonPublicKeyB64,
      };
    } catch {
      return null;
    }
  }

  return null;
}

export function normalizeStoredHostProfile(entry: unknown): HostProfile | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const serverId = typeof record.serverId === "string" ? record.serverId.trim() : "";
  if (!serverId) {
    return null;
  }

  const rawConnections = Array.isArray(record.connections) ? record.connections : [];
  const connections = rawConnections
    .map((connection) => normalizeStoredConnection(connection))
    .filter((connection): connection is HostConnection => connection !== null);
  if (connections.length === 0) {
    return null;
  }

  const now = new Date().toISOString();
  const label = normalizeHostLabel(
    typeof record.label === "string" ? record.label : null,
    serverId,
  );
  const preferredConnectionId =
    typeof record.preferredConnectionId === "string" &&
    connections.some((connection) => connection.id === record.preferredConnectionId)
      ? record.preferredConnectionId
      : (connections[0]?.id ?? null);

  return {
    serverId,
    label,
    lifecycle: defaultLifecycle(),
    connections,
    preferredConnectionId,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
  };
}

export function hostHasConnection(host: HostProfile, connection: HostConnection): boolean {
  return host.connections.some((existing) => hostConnectionEquals(existing, connection));
}

export function registryHasConnection(hosts: HostProfile[], connection: HostConnection): boolean {
  return hosts.some((host) => hostHasConnection(host, connection));
}
