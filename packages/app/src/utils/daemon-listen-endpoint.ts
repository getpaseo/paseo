import { parseHostPort } from "@/utils/daemon-endpoints";

const DEFAULT_DIRECT_PORT = 6767;

/**
 * Normalize a daemon listen / Host-header value into `host:port` for
 * connection probes. Hostnames without a port get the scheme default
 * (443 for TLS, 80 otherwise; localhost defaults to 6767).
 */
export function normalizeDaemonListenEndpoint(listen: string, useTls: boolean): string | null {
  const trimmed = listen.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = parseHostPort(trimmed);
    return parsed.isIpv6 ? `[${parsed.host}]:${parsed.port}` : `${parsed.host}:${parsed.port}`;
  } catch {
    const host = stripIpv6Brackets(trimmed);
    if (!host) {
      return null;
    }
    const port = defaultPortForHost(host, useTls);
    return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  }
}

function defaultPortForHost(host: string, useTls: boolean): number {
  if (useTls) {
    return 443;
  }
  if (host === "localhost" || host === "127.0.0.1") {
    return DEFAULT_DIRECT_PORT;
  }
  return 80;
}

function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}
