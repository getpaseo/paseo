import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (host: string) => Promise<ResolvedAddress[]>;

export type TunnelDestinationResolution =
  | {
      ok: true;
      addresses: ResolvedAddress[];
      port: number;
    }
  | {
      ok: false;
      code: "policy_denied" | "dns_failed" | "invalid_destination";
      message: string;
    };

const BLOCKED_METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.goog"]);
// fd00:ec2::254/128 — AWS IPv6 IMDSv2
const AWS_IPV6_METADATA_BYTES = new Uint8Array([
  0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54,
]);
// ::ffff:0:0/96 — IPv4-mapped IPv6 prefix (first 12 bytes)
const IPV4_MAPPED_IPV6_PREFIX = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]);

async function defaultHostResolver(host: string): Promise<ResolvedAddress[]> {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

function isLocalhostName(normalizedHost: string): boolean {
  return normalizedHost === "localhost" || normalizedHost.endsWith(".localhost");
}

function isBlockedMetadataHostname(normalizedHost: string): boolean {
  if (BLOCKED_METADATA_HOSTS.has(normalizedHost)) return true;
  if (normalizedHost.endsWith(".metadata.google.internal")) return true;
  if (normalizedHost.endsWith(".metadata.goog")) return true;
  return false;
}

function bytesMatchPrefix(bytes: Uint8Array, prefix: Uint8Array): boolean {
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function parseIpv4Bytes(ip: string): Uint8Array | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i]!;
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    out[i] = value;
  }
  return out;
}

function parseIpv6Group(group: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
  return Number.parseInt(group, 16);
}

function expandIpv6Half(half: string, allowEmbeddedIpv4: boolean): number[] | null {
  if (half.length === 0) return [];
  const tokens = half.split(":");
  const groups: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (allowEmbeddedIpv4 && i === tokens.length - 1 && token.includes(".")) {
      const ipv4 = parseIpv4Bytes(token);
      if (!ipv4) return null;
      groups.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
    } else {
      const parsed = parseIpv6Group(token);
      if (parsed === null) return null;
      groups.push(parsed);
    }
  }
  return groups;
}

function parseIpv6Bytes(rawIp: string): Uint8Array | null {
  const zoneIndex = rawIp.indexOf("%");
  const ip = zoneIndex >= 0 ? rawIp.slice(0, zoneIndex) : rawIp;
  if (ip.length === 0) return null;

  const doubleColonParts = ip.split("::");
  if (doubleColonParts.length > 2) return null;

  let groups: number[];
  if (doubleColonParts.length === 1) {
    const all = expandIpv6Half(doubleColonParts[0]!, true);
    if (!all || all.length !== 8) return null;
    groups = all;
  } else {
    const left = expandIpv6Half(doubleColonParts[0]!, false);
    const right = expandIpv6Half(doubleColonParts[1]!, true);
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  }

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const value = groups[i]!;
    out[i * 2] = (value >> 8) & 0xff;
    out[i * 2 + 1] = value & 0xff;
  }
  return out;
}

function isBlockedIpv4Bytes(bytes: Uint8Array): boolean {
  const a = bytes[0]!;
  const b = bytes[1]!;
  const c = bytes[2]!;
  const d = bytes[3]!;
  // 169.254.0.0/16 — link-local & cloud metadata (AWS, GCP, Azure, DigitalOcean, etc.)
  if (a === 169 && b === 254) return true;
  // 100.100.100.200/32 — Alibaba Cloud metadata
  return a === 100 && b === 100 && c === 100 && d === 200;
}

function isBlockedIpv6Bytes(bytes: Uint8Array): boolean {
  // fe80::/10 — IPv6 link-local (fe80:: through febf::)
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;
  // fd00:ec2::254/128 — AWS IPv6 IMDSv2
  if (bytesMatchPrefix(bytes, AWS_IPV6_METADATA_BYTES)) return true;
  // ::ffff:0:0/96 — IPv4-mapped IPv6
  if (bytesMatchPrefix(bytes, IPV4_MAPPED_IPV6_PREFIX)) {
    return isBlockedIpv4Bytes(bytes.subarray(12, 16));
  }
  return false;
}

export function isBlockedTunnelIp(ip: string): boolean {
  const unbracketed = stripIpv6Brackets(ip.trim());
  const ipv4 = parseIpv4Bytes(unbracketed);
  if (ipv4) return isBlockedIpv4Bytes(ipv4);
  const ipv6 = parseIpv6Bytes(unbracketed);
  if (ipv6) return isBlockedIpv6Bytes(ipv6);
  // Unknown / unparseable IP fails closed.
  return true;
}

async function resolveHostnameAddresses(
  normalized: string,
  resolveHost: HostResolver,
): Promise<{ ok: true; addresses: ResolvedAddress[] } | { ok: false; message: string }> {
  try {
    const resolved = await resolveHost(normalized);
    if (resolved.length > 0) {
      return { ok: true, addresses: resolved };
    }
    if (isLocalhostName(normalized)) {
      return { ok: true, addresses: [{ address: "127.0.0.1", family: 4 }] };
    }
    return { ok: false, message: `No DNS records found for ${normalized}` };
  } catch (error) {
    // RFC 6761: *.localhost always maps to loopback even when the stub resolver lacks it.
    if (isLocalhostName(normalized)) {
      return { ok: true, addresses: [{ address: "127.0.0.1", family: 4 }] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Failed to resolve ${normalized}: ${message}` };
  }
}

export async function resolveAndValidateTunnelDestination(
  rawHost: string,
  port: number,
  resolveHost: HostResolver = defaultHostResolver,
): Promise<TunnelDestinationResolution> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, code: "invalid_destination", message: `Invalid destination port: ${port}` };
  }

  const trimmed = rawHost.trim();
  if (trimmed.length === 0 || trimmed.includes("\0") || /\s/.test(trimmed)) {
    return { ok: false, code: "invalid_destination", message: "Invalid destination host" };
  }

  const unbracketed = stripIpv6Brackets(trimmed);
  const ipVersion = isIP(unbracketed.split("%")[0] ?? unbracketed);
  if (ipVersion === 4 || ipVersion === 6) {
    if (isBlockedTunnelIp(unbracketed)) {
      return {
        ok: false,
        code: "policy_denied",
        message: `Destination address is blocked by daemon tunnel policy: ${unbracketed}`,
      };
    }
    return { ok: true, addresses: [{ address: unbracketed, family: ipVersion }], port };
  }

  const normalized = normalizeHostname(unbracketed);
  if (isBlockedMetadataHostname(normalized)) {
    return {
      ok: false,
      code: "policy_denied",
      message: `Destination hostname is blocked by daemon tunnel policy: ${normalized}`,
    };
  }

  const resolved = await resolveHostnameAddresses(normalized, resolveHost);
  if (!resolved.ok) {
    return { ok: false, code: "dns_failed", message: resolved.message };
  }

  // Fail closed if ANY resolved record points to a blocked address.
  for (const entry of resolved.addresses) {
    if (isBlockedTunnelIp(entry.address)) {
      return {
        ok: false,
        code: "policy_denied",
        message: `Destination ${normalized} resolved to blocked address ${entry.address}`,
      };
    }
  }

  return { ok: true, addresses: resolved.addresses, port };
}
