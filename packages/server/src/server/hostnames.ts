import net from "node:net";
import {
  type HostTarget,
  matchesHostPattern,
  parseHostAuthority,
  parseHostPattern,
} from "./host-patterns.js";

export type HostnamesConfig = true | string[] | undefined;

function isDefaultAllowedHostname(hostname: string): boolean {
  // Vite-style defaults: localhost, *.localhost, and all IP addresses.
  if (hostname === "localhost") return true;
  if (hostname.endsWith(".localhost")) return true;
  if (net.isIP(hostname) !== 0) return true;
  return false;
}

/**
 * Vite-style hostname allowlist check, adapted to raw Host headers.
 *
 * Semantics:
 * - `hostnames === true` => allow any host.
 * - `hostnames === []` or `undefined` => allow localhost, *.localhost, and all IPs.
 * - `hostnames === ['.example.com', 'myhost']` => allow those *in addition* to defaults.
 *
 * Entries follow the grammar in host-patterns.ts. The Host header's port is
 * ignored unless the entry names one.
 */
export function isHostnameAllowed(
  hostHeader: string | undefined,
  hostnames: HostnamesConfig,
): boolean {
  const authority = hostHeader ? parseHostAuthority(hostHeader) : null;
  if (!authority) return false;

  if (hostnames === true) return true;

  // Defaults are always allowed.
  if (isDefaultAllowedHostname(authority.hostname)) return true;

  const target: HostTarget = { ...authority, scheme: null, defaultPort: null };
  for (const raw of hostnames ?? []) {
    const pattern = parseHostPattern(raw, { unspecifiedPort: "any" });
    if (pattern && matchesHostPattern(pattern, target)) return true;
  }
  return false;
}

export function mergeHostnames(values: Array<HostnamesConfig>): HostnamesConfig {
  let merged: string[] = [];
  for (const value of values) {
    if (value === true) return true;
    if (!value) continue;
    merged = merged.concat(value);
  }

  const deduped = Array.from(new Set(merged.map((v) => v.trim()).filter((v) => v.length > 0)));
  return deduped;
}

export function parseHostnamesEnv(raw: string | undefined): HostnamesConfig {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "true") return true;
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
