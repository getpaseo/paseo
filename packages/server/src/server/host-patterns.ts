import net from "node:net";

/**
 * Allowlist grammar shared by `daemon.hostnames` and `daemon.cors.allowedOrigins`:
 *
 *   [scheme://][.]host[:[port]]
 *
 * A leading `.` matches the host and every subdomain. `host:1234` matches that
 * port only; `host:` matches any port, including none. What a pattern without a
 * port means is the caller's decision, see `ParseHostPatternOptions`. IPv6
 * literals are bracketed so the port separator stays unambiguous.
 */
export interface HostPattern {
  scheme: string | null;
  host: string;
  matchesSubdomains: boolean;
  port: PortRule;
}

export type PortRule = { kind: "any" } | { kind: "implicit" } | { kind: "exact"; port: string };

export interface HostAuthority {
  hostname: string;
  port: string | null;
}

export interface HostTarget extends HostAuthority {
  scheme: string | null;
  defaultPort: string | null;
}

export interface ParseHostPatternOptions {
  /**
   * Rule for a pattern that has no `:` at all. Host header checks use `any`
   * (Vite semantics; `hostnames: ["myhost"]` has always matched `myhost:6767`).
   * Origin checks use `implicit`, so `https://app.example.com` keeps meaning
   * exactly that origin and not `https://app.example.com:8443`.
   */
  unspecifiedPort: "any" | "implicit";
}

interface HostPortSplit {
  host: string;
  /** `null` when there is no `:` separator, `""` when nothing follows it. */
  port: string | null;
}

function splitHostPort(value: string): HostPortSplit | null {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return null;
    const host = value.slice(1, end);
    if (!net.isIPv6(host)) return null;
    const rest = value.slice(end + 1);
    if (!rest) return { host, port: null };
    if (!rest.startsWith(":")) return null;
    return { host, port: rest.slice(1) };
  }

  const colon = value.indexOf(":");
  if (colon === -1) return { host: value, port: null };
  const port = value.slice(colon + 1);
  if (port.includes(":")) return null;
  return { host: value.slice(0, colon), port };
}

/** Canonical decimal port, so `06767` and `6767` compare equal. */
function parsePort(value: string): string | null {
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port <= 65535 ? String(port) : null;
}

export function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Default port for a `URL.protocol` value such as `https:`. */
export function defaultPortForProtocol(protocol: string): string | null {
  if (protocol === "http:") return "80";
  if (protocol === "https:") return "443";
  return null;
}

/** Parses a raw `Host` header into hostname and explicit port. */
export function parseHostAuthority(hostHeader: string): HostAuthority | null {
  const split = splitHostPort(hostHeader.trim());
  if (!split || !split.host) return null;
  const hostname = split.host.toLowerCase();
  if (split.port === null) return { hostname, port: null };
  const port = parsePort(split.port);
  return port ? { hostname, port } : null;
}

export function parseHostPattern(
  raw: string,
  options: ParseHostPatternOptions,
): HostPattern | null {
  let rest = raw.trim().toLowerCase();
  let scheme: string | null = null;
  const schemeEnd = rest.indexOf("://");
  if (schemeEnd !== -1) {
    scheme = rest.slice(0, schemeEnd);
    rest = rest.slice(schemeEnd + 3);
    if (!scheme) return null;
  }

  const matchesSubdomains = rest.startsWith(".");
  if (matchesSubdomains) rest = rest.slice(1);

  const split = splitHostPort(rest);
  if (!split || !split.host) return null;
  const port = parsePortRule(split.port, options.unspecifiedPort);
  if (!port) return null;
  return { scheme, host: split.host, matchesSubdomains, port };
}

function parsePortRule(
  port: string | null,
  unspecified: ParseHostPatternOptions["unspecifiedPort"],
): PortRule | null {
  if (port === null) return { kind: unspecified };
  if (port === "") return { kind: "any" };
  const canonical = parsePort(port);
  return canonical ? { kind: "exact", port: canonical } : null;
}

export function matchesHostPattern(pattern: HostPattern, target: HostTarget): boolean {
  if (pattern.scheme !== null && pattern.scheme !== target.scheme) return false;
  if (!matchesHost(pattern, target.hostname)) return false;
  return matchesPort(pattern.port, target);
}

function matchesHost(pattern: HostPattern, hostname: string): boolean {
  if (hostname === pattern.host) return true;
  return pattern.matchesSubdomains && hostname.endsWith(`.${pattern.host}`);
}

function matchesPort(rule: PortRule, target: HostTarget): boolean {
  switch (rule.kind) {
    case "any":
      return true;
    case "implicit":
      return target.port === null;
    case "exact":
      return (target.port ?? target.defaultPort) === rule.port;
  }
}
