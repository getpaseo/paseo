export type HostPortParts = {
  host: string;
  port: number;
  isIpv6: boolean;
};

export type RelayRole = "server" | "client";

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

export function deriveLabelFromEndpoint(endpoint: string): string {
  try {
    const { host } = parseHostPort(endpoint);
    return host || "Unnamed Host";
  } catch {
    return "Unnamed Host";
  }
}

function shouldUseSecureWebSocket(port: number): boolean {
  return port === 443;
}

export function buildDaemonWebSocketUrl(endpoint: string): string {
  const { host, port, isIpv6 } = parseHostPort(endpoint);
  const protocol = shouldUseSecureWebSocket(port) ? "wss" : "ws";
  const hostPart = isIpv6 ? `[${host}]` : host;
  return `${protocol}://${hostPart}:${port}/ws`;
}

export function buildRelayWebSocketUrl(params: {
  endpoint: string;
  serverId: string;
  role: RelayRole;
  clientId?: string;
}): string {
  const { host, port, isIpv6 } = parseHostPort(params.endpoint);
  const protocol = shouldUseSecureWebSocket(port) ? "wss" : "ws";
  const hostPart = isIpv6 ? `[${host}]` : host;
  const url = new URL(`${protocol}://${hostPart}:${port}/ws`);
  url.searchParams.set("serverId", params.serverId);
  url.searchParams.set("role", params.role);
  if (params.clientId) {
    url.searchParams.set("clientId", params.clientId);
  }
  return url.toString();
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
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "wss:" ? 443 : 80;
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
    return (
      parsed.searchParams.get("role") === "client" &&
      parsed.searchParams.has("serverId")
    );
  } catch {
    return false;
  }
}
