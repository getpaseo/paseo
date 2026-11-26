import type { ActiveConnection } from "@/runtime/host-runtime";
import type { HostConnection } from "@/types/host-connection";

export type HostConnectionKind = "local" | "relay" | "tailscale" | "ssh" | "direct" | "routed";

export interface HostConnectionDisplay {
  kind: HostConnectionKind;
  /** Address shown beside the connection kind. Omitted for local transports. */
  endpoint?: string;
}

// Standard secure/plain web ports carry no information in the host display, so
// "relay.paseo.sh:443" reads as "relay.paseo.sh" while "127.0.0.1:6767" is kept.
export function formatConnectionEndpoint(endpoint: string): string {
  return endpoint.replace(/:(?:443|80)$/, "");
}

function extractEndpointHost(endpoint: string): string {
  const trimmed = endpoint.trim().toLowerCase();
  if (!trimmed) return "";

  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const authority = withoutScheme.split("/")[0] ?? "";
  const hostPort = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;

  if (hostPort.startsWith("[")) {
    const closeBracket = hostPort.indexOf("]");
    return closeBracket > 1 ? hostPort.slice(1, closeBracket) : hostPort;
  }

  const firstColon = hostPort.indexOf(":");
  const lastColon = hostPort.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon) {
    return hostPort.slice(0, firstColon);
  }
  return hostPort;
}

function isTailscaleIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  // Tailscale assigns addresses from the RFC 6598 CGNAT range 100.64.0.0/10.
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function isTailscaleIpv6(host: string): boolean {
  return host.startsWith("fd7a:115c:a1e0:");
}

export function isTailscaleEndpoint(endpoint: string): boolean {
  const host = extractEndpointHost(endpoint);
  if (!host) return false;
  if (host.endsWith(".ts.net") && host.length > ".ts.net".length) {
    return true;
  }
  return isTailscaleIpv4(host) || isTailscaleIpv6(host);
}

export function isLoopbackEndpoint(endpoint: string): boolean {
  const host = extractEndpointHost(endpoint);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function describeActiveConnection(
  connection: ActiveConnection,
  options?: { isLocalHost?: boolean },
): HostConnectionDisplay {
  switch (connection.type) {
    case "directSocket":
    case "directPipe":
      return { kind: "local" };
    case "relay":
      return { kind: "relay", endpoint: formatConnectionEndpoint(connection.endpoint) };
    case "remoteSsh":
      return { kind: "ssh", endpoint: connection.endpoint };
    case "routed":
      return { kind: "routed", endpoint: connection.endpoint };
    case "directTcp": {
      if (options?.isLocalHost && isLoopbackEndpoint(connection.endpoint)) {
        return { kind: "local" };
      }
      if (isTailscaleEndpoint(connection.endpoint)) {
        return { kind: "tailscale", endpoint: formatConnectionEndpoint(connection.endpoint) };
      }
      return { kind: "direct", endpoint: formatConnectionEndpoint(connection.endpoint) };
    }
  }
}

export function describeHostConnection(
  connection: HostConnection,
  options?: { isLocalHost?: boolean },
): HostConnectionDisplay {
  switch (connection.type) {
    case "directSocket":
    case "directPipe":
      return { kind: "local" };
    case "relay":
      return { kind: "relay", endpoint: formatConnectionEndpoint(connection.relayEndpoint) };
    case "remoteSsh":
      return { kind: "ssh", endpoint: connection.host };
    case "routed":
      return { kind: "routed", endpoint: connection.originServerId };
    case "directTcp": {
      if (options?.isLocalHost && isLoopbackEndpoint(connection.endpoint)) {
        return { kind: "local" };
      }
      if (isTailscaleEndpoint(connection.endpoint)) {
        return { kind: "tailscale", endpoint: formatConnectionEndpoint(connection.endpoint) };
      }
      return { kind: "direct", endpoint: formatConnectionEndpoint(connection.endpoint) };
    }
  }
}
