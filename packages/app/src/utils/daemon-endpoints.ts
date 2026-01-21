import { Buffer } from "buffer";

export type HostPortParts = {
  host: string;
  port: number;
  isIpv6: boolean;
};

function decodeBase64UrlToUtf8(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

export function decodeOfferFragmentPayload(encoded: string): unknown {
  const json = decodeBase64UrlToUtf8(encoded);
  return JSON.parse(json) as unknown;
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
    const port = Number(match[2]);
    if (!host) throw new Error("Host is required");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Port must be between 1 and 65535");
    }
    return { host, port, isIpv6: true };
  }

  const match = trimmed.match(/^(.+):(\d{1,5})$/);
  if (!match) {
    throw new Error("Invalid host:port (expected localhost:6767)");
  }
  const host = match[1].trim();
  const port = Number(match[2]);
  if (!host) throw new Error("Host is required");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be between 1 and 65535");
  }
  return { host, port, isIpv6: false };
}

export function normalizeHostPort(input: string): string {
  const { host, port, isIpv6 } = parseHostPort(input);
  if (isIpv6) {
    return `[${host}]:${port}`;
  }
  return `${host}:${port}`;
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
  const hostPort = isIpv6 ? `[${host}]:${port}` : `${host}:${port}`;
  return hostPort;
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

export function buildRelayWebSocketUrl(params: { endpoint: string; sessionId: string }): string {
  const { host, port, isIpv6 } = parseHostPort(params.endpoint);
  const protocol = shouldUseSecureWebSocket(port) ? "wss" : "ws";
  const hostPart = isIpv6 ? `[${host}]` : host;
  const url = new URL(`${protocol}://${hostPart}:${port}/ws`);
  url.searchParams.set("session", params.sessionId);
  url.searchParams.set("role", "client");
  return url.toString();
}

export function deriveLabelFromEndpoint(endpoint: string): string {
  try {
    const { host } = parseHostPort(endpoint);
    return host || "Unnamed Host";
  } catch {
    return "Unnamed Host";
  }
}

