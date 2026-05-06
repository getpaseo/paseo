export interface HostPortParts {
  host: string;
  port: number;
  isIpv6: boolean;
}

export interface ConnectionUriParts extends HostPortParts {
  useTls: boolean;
}

export interface ParsedConnectionUri extends ConnectionUriParts {
  password?: string;
}

export type RelayRole = "server" | "client";
export type RelayProtocolVersion = "1" | "2";

export const CURRENT_RELAY_PROTOCOL_VERSION: RelayProtocolVersion = "2";
export const DEFAULT_RELAY_ENDPOINT = "relay.paseo.sh:443";

export function normalizeRelayProtocolVersion(
  value: unknown,
  fallback: RelayProtocolVersion = CURRENT_RELAY_PROTOCOL_VERSION,
): RelayProtocolVersion {
  if (value == null) {
    return fallback;
  }

  let normalized = "";
  if (typeof value === "string") {
    normalized = value.trim();
  } else if (typeof value === "number") {
    normalized = String(value);
  }
  if (!normalized) {
    return fallback;
  }
  if (normalized === "1" || normalized === "2") {
    return normalized;
  }
  throw new Error('Relay version must be "1" or "2"');
}

function parsePort(portStr: string, context: string): number {
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${context}: port must be between 1 and 65535`);
  }
  return port;
}

export function parseHostPort(input: string): HostPortParts {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Host is required");
  }

  // IPv6: [::1]:6767
  if (trimmed.startsWith("[")) {
    const match = trimmed.match(/^\[([^\]]+)\]:(\d{1,5})$/);
    if (!match) {
      throw new Error("Invalid host:port (expected [::1]:6767)");
    }
    const host = match[1].trim();
    if (!host) throw new Error("Host is required");
    const port = parsePort(match[2], "Invalid host:port");
    return { host, port, isIpv6: true };
  }

  const match = trimmed.match(/^(.+):(\d{1,5})$/);
  if (!match) {
    throw new Error("Invalid host:port (expected localhost:6767)");
  }
  const host = match[1].trim();
  if (!host) throw new Error("Host is required");
  const port = parsePort(match[2], "Invalid host:port");
  return { host, port, isIpv6: false };
}

export function normalizeHostPort(input: string): string {
  const { host, port, isIpv6 } = parseHostPort(input);
  return isIpv6 ? `[${host}]:${port}` : `${host}:${port}`;
}

export function parseConnectionUri(input: string): ParsedConnectionUri {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Connection URI is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid connection URI");
  }

  if (parsed.protocol !== "tcp:") {
    throw new Error("Connection URI protocol must be tcp:");
  }
  if (!parsed.hostname) {
    throw new Error("Connection URI host is required");
  }
  if (!parsed.port) {
    throw new Error("Connection URI port is required");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Connection URI userinfo is not supported");
  }

  const isIpv6 = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
  const host = isIpv6 ? parsed.hostname.slice(1, -1) : parsed.hostname;
  const password = parsed.searchParams.get("password") || undefined;

  return {
    host,
    port: parsePort(parsed.port, "Invalid connection URI"),
    isIpv6,
    useTls: parsed.searchParams.get("ssl") === "true",
    ...(password ? { password } : {}),
  };
}

export function serializeConnectionUri(parts: ConnectionUriParts): string {
  return createConnectionUri(parts).toString();
}

export function serializeConnectionUriForStorage(parts: ParsedConnectionUri): string {
  const url = createConnectionUri(parts);
  if (parts.password) {
    url.searchParams.set("password", parts.password);
  }
  return url.toString();
}

function createConnectionUri(parts: ConnectionUriParts): URL {
  const hostPart = parts.isIpv6 ? `[${parts.host}]` : parts.host;
  const url = new URL(`tcp://${hostPart}:${parts.port}`);
  if (parts.useTls) {
    url.searchParams.set("ssl", "true");
  }
  return url;
}

export function normalizeLoopbackToLocalhost(endpoint: string): string {
  const { host, port, isIpv6 } = parseHostPort(endpoint);
  if (host === "127.0.0.1" || (!isIpv6 && host === "0.0.0.0")) {
    return `localhost:${port}`;
  }
  if (isIpv6 && (host === "::1" || host === "::")) {
    return `localhost:${port}`;
  }
  return endpoint;
}

export function deriveLabelFromEndpoint(endpoint: string): string {
  try {
    const { host } = parseHostPort(endpoint);
    return host || "Unnamed Host";
  } catch {
    return "Unnamed Host";
  }
}

export interface WebSocketUrlOptions {
  useTls: boolean;
}

export function buildDaemonWebSocketUrl(endpoint: string, opts: WebSocketUrlOptions): string {
  const { host, port, isIpv6 } = parseHostPort(endpoint);
  const protocol = opts.useTls ? "wss" : "ws";
  const hostPart = isIpv6 ? `[${host}]` : host;
  return new URL(`${protocol}://${hostPart}:${port}/ws`).toString();
}

export function buildRelayWebSocketUrl(params: {
  endpoint: string;
  useTls: boolean;
  serverId: string;
  role: RelayRole;
  /**
   * Per-connection routing identifier used by the daemon to open server data sockets.
   * Clients should NOT provide this — the relay assigns a routing ID on connect.
   */
  connectionId?: string;
  version?: RelayProtocolVersion | 1 | 2;
}): string {
  const { host, port, isIpv6 } = parseHostPort(params.endpoint);
  const protocol = params.useTls ? "wss" : "ws";
  const hostPart = isIpv6 ? `[${host}]` : host;
  const url = new URL(`${protocol}://${hostPart}:${port}/ws`);
  url.searchParams.set("serverId", params.serverId);
  url.searchParams.set("role", params.role);
  url.searchParams.set("v", normalizeRelayProtocolVersion(params.version));
  if (params.connectionId) {
    url.searchParams.set("connectionId", params.connectionId);
  }
  return url.toString();
}

/**
 * @deprecated Migration fallback for stored relay connections/offers that predate
 * explicit relay useTls. Delete after two release cycles.
 */
export function shouldUseTlsForDefaultHostedRelay(endpoint: string): boolean {
  try {
    const { port } = parseHostPort(endpoint);
    return port === 443;
  } catch {
    return false;
  }
}

export function extractHostPortFromWebSocketUrl(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("Invalid WebSocket URL protocol");
  }
  if (parsed.pathname.replace(/\/+$/, "") !== "/ws") {
    throw new Error("Invalid WebSocket URL (expected /ws path)");
  }

  const host = parsed.hostname;
  let port: number;
  if (parsed.port) {
    port = Number(parsed.port);
  } else if (parsed.protocol === "wss:") {
    port = 443;
  } else {
    port = 80;
  }
  if (!host) {
    throw new Error("Invalid WebSocket URL (missing hostname)");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid WebSocket URL (invalid port)");
  }

  const isIpv6 = host.includes(":") && !host.startsWith("[") && !host.endsWith("]");
  return isIpv6 ? `[${host}]:${port}` : `${host}:${port}`;
}

export function isRelayClientWebSocketUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("role") === "client" && parsed.searchParams.has("serverId");
  } catch {
    return false;
  }
}
