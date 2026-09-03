import {
  type HostTarget,
  defaultPortForProtocol,
  matchesHostPattern,
  parseHostPattern,
  stripIpv6Brackets,
} from "./host-patterns.js";

/**
 * `daemon.cors.allowedOrigins` check shared by the CORS middleware and the
 * WebSocket upgrade. `*` allows every origin. Other entries follow the grammar
 * in host-patterns.ts: an entry without a scheme matches any scheme, and one
 * without a port matches only an origin that has no explicit port.
 */
export function isOriginAllowed(origin: string, allowedOrigins: Iterable<string>): boolean {
  const target = parseOrigin(origin);
  for (const entry of allowedOrigins) {
    if (entry === "*" || entry === origin) return true;
    if (!target) continue;
    const pattern = parseHostPattern(entry, { unspecifiedPort: "implicit" });
    if (pattern && matchesHostPattern(pattern, target)) return true;
  }
  return false;
}

// Browsers serialize origins canonically: lowercase scheme and host, default
// port omitted, nothing after the authority. Anything else, including `null`
// for opaque origins, only matches an exact entry.
function parseOrigin(origin: string): HostTarget | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (`${url.protocol}//${url.host}` !== origin) return null;
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (!hostname) return null;
  return {
    scheme: url.protocol.slice(0, -1),
    hostname,
    port: url.port || null,
    defaultPort: defaultPortForProtocol(url.protocol),
  };
}
