import net from "node:net";

export type AllowedHostsConfig = true | string[] | undefined;

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}

function parseHostnameFromHostHeader(hostHeader: string): string | null {
  const trimmed = hostHeader.trim();
  if (!trimmed) return null;

  // IPv6 in brackets: [::1]:6767
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return null;
    return normalizeHostname(trimmed.slice(1, end));
  }

  // IPv4/hostname with optional port: localhost:6767
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1) {
    return normalizeHostname(trimmed);
  }
  return normalizeHostname(trimmed.slice(0, colonIndex));
}

function matchesAllowedHostPattern(hostname: string, pattern: string): boolean {
  const normalizedPattern = normalizeHostname(pattern);
  if (!normalizedPattern) return false;

  if (normalizedPattern.startsWith(".")) {
    const base = normalizedPattern.slice(1);
    if (!base) return false;
    return hostname === base || hostname.endsWith(`.${base}`);
  }

  return hostname === normalizedPattern;
}

function isDefaultAllowedHostname(hostname: string): boolean {
  // Vite-style defaults: localhost, *.localhost, and all IP addresses.
  if (hostname === "localhost") return true;
  if (hostname.endsWith(".localhost")) return true;
  if (net.isIP(hostname) !== 0) return true;
  return false;
}

/**
 * Vite-style allowed hosts check, adapted to raw Host headers.
 *
 * Semantics:
 * - `allowedHosts === true` => allow any host.
 * - `allowedHosts === []` or `undefined` => allow localhost, *.localhost, and all IPs.
 * - `allowedHosts === ['.example.com', 'myhost']` => allow those *in addition* to defaults.
 */
export function isHostAllowed(
  hostHeader: string | undefined,
  allowedHosts: AllowedHostsConfig
): boolean {
  const hostname = hostHeader ? parseHostnameFromHostHeader(hostHeader) : null;
  if (!hostname) return false;

  if (allowedHosts === true) return true;

  // Defaults are always allowed.
  if (isDefaultAllowedHostname(hostname)) return true;

  const patterns = allowedHosts ?? [];
  for (const pattern of patterns) {
    if (matchesAllowedHostPattern(hostname, pattern)) return true;
  }
  return false;
}

export function mergeAllowedHosts(
  values: Array<AllowedHostsConfig>
): AllowedHostsConfig {
  let merged: string[] = [];
  for (const value of values) {
    if (value === true) return true;
    if (!value) continue;
    merged = merged.concat(value);
  }

  const deduped = Array.from(
    new Set(merged.map((v) => v.trim()).filter((v) => v.length > 0))
  );
  return deduped;
}

export function parseAllowedHostsEnv(
  raw: string | undefined
): AllowedHostsConfig {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "true") return true;
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

