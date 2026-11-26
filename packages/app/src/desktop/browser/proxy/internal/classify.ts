import { parseHostPort } from "@getpaseo/protocol/daemon-endpoints";
import type { DesktopBrowserProxyTarget } from "@/desktop/host";
import type { ActiveConnection, HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import type { HostConnection } from "@/types/host-connection";

const IPV4_LOOPBACK_PATTERN = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!normalized) return false;
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    IPV4_LOOPBACK_PATTERN.test(normalized)
  );
}

export function isLoopbackBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isLoopbackDirectTcpEndpoint(endpoint: string): boolean {
  try {
    const { host } = parseHostPort(endpoint);
    return isLoopbackHost(host);
  } catch {
    return false;
  }
}

export function isLocalHostConnection(connection: HostConnection | ActiveConnection): boolean {
  if (connection.type === "directSocket" || connection.type === "directPipe") {
    return true;
  }
  if (connection.type === "directTcp") {
    return isLoopbackDirectTcpEndpoint(connection.endpoint);
  }
  return false;
}

export function extractBrowserProxyTarget(
  serverId: string,
  connection: HostConnection,
): DesktopBrowserProxyTarget | null {
  if (connection.type === "directTcp") {
    if (isLoopbackDirectTcpEndpoint(connection.endpoint)) {
      return null;
    }
    return {
      type: "directTcp",
      endpoint: connection.endpoint,
      ...(connection.useTls !== undefined ? { useTls: connection.useTls } : {}),
    };
  }
  if (connection.type === "remoteSsh") {
    return {
      type: "remoteSsh",
      host: connection.host,
      ...(connection.sshPort !== undefined ? { sshPort: connection.sshPort } : {}),
      ...(connection.daemonPort !== undefined ? { daemonPort: connection.daemonPort } : {}),
    };
  }
  if (connection.type === "relay") {
    return {
      type: "relay",
      serverId,
      relayEndpoint: connection.relayEndpoint,
      ...(connection.useTls !== undefined ? { useTls: connection.useTls } : {}),
      daemonPublicKeyB64: connection.daemonPublicKeyB64,
      ...(connection.minimumSecurityMode === "protected"
        ? { minimumSecurityMode: "protected" }
        : {}),
    };
  }
  return null;
}

export type HostBrowserRouting =
  | { kind: "local" }
  | { kind: "remote"; support: "supported"; target: DesktopBrowserProxyTarget }
  | { kind: "remote"; support: "daemon_update_required" }
  | { kind: "remote"; support: "routed_unsupported" }
  | { kind: "remote"; support: "host_connecting" }
  | { kind: "remote"; support: "host_offline" };

export interface ClassifyHostBrowserRoutingInput {
  serverId: string;
  connections: readonly HostConnection[];
  activeConnection: ActiveConnection | null;
  activeConnectionId: string | null;
  connectionStatus: HostRuntimeConnectionStatus;
  supportsNetworkTunnel: boolean | null;
}

function findMatchingHostConnection(
  connections: readonly HostConnection[],
  activeConnectionId: string | null,
  activeConnection: ActiveConnection | null,
): HostConnection | null {
  if (activeConnectionId) {
    const byId = connections.find((conn) => conn.id === activeConnectionId);
    if (byId) return byId;
  }
  if (activeConnection) {
    const byType = connections.find((conn) => {
      if (conn.type !== activeConnection.type) return false;
      if (conn.type === "directTcp") return conn.endpoint === activeConnection.endpoint;
      if (conn.type === "remoteSsh") return conn.host === activeConnection.endpoint;
      if (conn.type === "relay") return conn.relayEndpoint === activeConnection.endpoint;
      if (conn.type === "routed") return conn.originServerId === activeConnection.endpoint;
      return true;
    });
    if (byType) return byType;
  }
  return null;
}

export function classifyHostBrowserRouting(
  input: ClassifyHostBrowserRoutingInput,
): HostBrowserRouting {
  const {
    serverId,
    connections,
    activeConnection,
    activeConnectionId,
    connectionStatus,
    supportsNetworkTunnel,
  } = input;

  if (activeConnection) {
    if (isLocalHostConnection(activeConnection)) {
      return { kind: "local" };
    }
    if (activeConnection.type === "routed") {
      return { kind: "remote", support: "routed_unsupported" };
    }
  } else {
    // No active connection yet (connecting/offline). Distinguish local hosts from remote
    // hosts using saved connection definitions so remote tabs fail closed during startup.
    if (connections.length === 0 || connections.some(isLocalHostConnection)) {
      return { kind: "local" };
    }
    if (connections.every((conn) => conn.type === "routed")) {
      return { kind: "remote", support: "routed_unsupported" };
    }
  }

  if (connectionStatus === "connecting" || connectionStatus === "idle") {
    return { kind: "remote", support: "host_connecting" };
  }
  if (connectionStatus !== "online") {
    return { kind: "remote", support: "host_offline" };
  }

  // COMPAT(networkTunnel): added in v0.18.0, remove after 2027-05-26 once daemon floor >= v0.18.0.
  if (supportsNetworkTunnel !== true) {
    return { kind: "remote", support: "daemon_update_required" };
  }

  const matchedConnection = findMatchingHostConnection(
    connections,
    activeConnectionId,
    activeConnection,
  );
  const target = matchedConnection ? extractBrowserProxyTarget(serverId, matchedConnection) : null;
  if (!target) {
    return { kind: "remote", support: "host_offline" };
  }

  return { kind: "remote", support: "supported", target };
}

export function shouldOpenUrlInProxiedWorkspaceBrowser(input: {
  isElectron: boolean;
  url: string;
  routing: HostBrowserRouting;
}): boolean {
  return (
    input.isElectron &&
    isLoopbackBrowserUrl(input.url) &&
    input.routing.kind === "remote" &&
    input.routing.support === "supported"
  );
}
