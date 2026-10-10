import { BlockList, isIP, isIPv4, isIPv6 } from "node:net";
import { TunnelCloseReason, type TunnelTarget } from "@getpaseo/protocol/binary-frames/index";

/**
 * Host-side egress policy for tunnel streams. The client never picks the IP the
 * daemon dials: names resolve here, every resolved address is checked, and the
 * approved literal is what `net.connect` receives. Cloud metadata and link-local
 * ranges are denied because a tunnel that reaches them turns the daemon into an
 * instance-credential oracle for whoever holds the client.
 */
const deniedAddresses = new BlockList();
deniedAddresses.addSubnet("169.254.0.0", 16, "ipv4");
deniedAddresses.addAddress("100.100.100.200", "ipv4");
deniedAddresses.addSubnet("fe80::", 10, "ipv6");
deniedAddresses.addAddress("fd00:ec2::254", "ipv6");

const NAT64_WELL_KNOWN_PREFIX = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];
const NAT64_LOCAL_PREFIX = [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01];
const SIX_TO_FOUR_PREFIX = [0x20, 0x02];
const IPV4_COMPATIBLE_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const SIIT_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0];

export interface ResolvedTunnelAddress {
  address: string;
  family: 4 | 6;
}

export class TunnelTargetError extends Error {
  constructor(
    public readonly reason: (typeof TunnelCloseReason)[keyof typeof TunnelCloseReason],
    message: string,
  ) {
    super(message);
    this.name = "TunnelTargetError";
  }
}

export type TunnelHost =
  | { kind: "literal"; address: ResolvedTunnelAddress }
  | { kind: "name"; hostname: string };

export function describeTunnelTarget(target: TunnelTarget): TunnelHost {
  switch (target.atyp) {
    case 1:
      return {
        kind: "literal",
        address: { address: Array.from(target.address).join("."), family: 4 },
      };
    case 4:
      return { kind: "literal", address: normalizeAddress(formatIPv6(target.address)) };
    case 3: {
      // SOCKS-style proxies hand IP literals over in the domain slot ("127.0.0.1", "::1").
      const literal = target.address.replace(/^\[(.*)\]$/, "$1");
      if (isIP(literal)) return { kind: "literal", address: normalizeAddress(literal) };
      return { kind: "name", hostname: target.address };
    }
  }
}

/** Collapses IPv4-mapped IPv6 (`::ffff:a.b.c.d`) to IPv4 so one check and one dial cover both forms. */
export function normalizeAddress(address: string): ResolvedTunnelAddress {
  if (isIPv4(address)) return { address, family: 4 };
  if (!isIPv6(address)) throw new TunnelTargetError(TunnelCloseReason.GeneralError, "Invalid IP");
  const mapped = /^(?:0*:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return { address: mapped[1], family: 4 };
  const hexMapped = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hexMapped) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    return { address: `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`, family: 4 };
  }
  return { address, family: 6 };
}

export function isDeniedAddress(resolved: ResolvedTunnelAddress): boolean {
  const normalized = normalizeAddress(resolved.address);
  if (normalized.family === 4) return deniedAddresses.check(normalized.address, "ipv4");

  const embedded = extractEmbeddedIPv4(normalized.address);
  if (embedded) return isDeniedAddress({ address: embedded, family: 4 });
  return deniedAddresses.check(normalized.address, "ipv6");
}

/** Throws PolicyDenied when any candidate is denied: a name that mixes approved and denied answers is not trusted. */
export function approveAddresses(
  candidates: readonly ResolvedTunnelAddress[],
): readonly ResolvedTunnelAddress[] {
  if (candidates.length === 0) {
    throw new TunnelTargetError(TunnelCloseReason.HostNotFound, "Host has no addresses");
  }
  for (const candidate of candidates) {
    if (isDeniedAddress(candidate)) {
      throw new TunnelTargetError(TunnelCloseReason.PolicyDenied, "Target address is denied");
    }
  }
  return candidates;
}

const HOST_NOT_FOUND_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NODATA",
  "EAI_NONAME",
  "EAI_FAIL",
]);
const NETWORK_UNREACHABLE_CODES = new Set(["EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "ENETDOWN"]);

export function closeReasonForError(
  error: unknown,
): (typeof TunnelCloseReason)[keyof typeof TunnelCloseReason] {
  if (error instanceof TunnelTargetError) return error.reason;
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== "string") return TunnelCloseReason.GeneralError;
  if (HOST_NOT_FOUND_CODES.has(code)) return TunnelCloseReason.HostNotFound;
  if (code === "ECONNREFUSED") return TunnelCloseReason.ConnectionRefused;
  if (NETWORK_UNREACHABLE_CODES.has(code)) return TunnelCloseReason.NetworkUnreachable;
  if (code === "ETIMEDOUT") return TunnelCloseReason.Timeout;
  return TunnelCloseReason.GeneralError;
}

function formatIPv6(octets: Uint8Array): string {
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(((octets[index] << 8) | octets[index + 1]).toString(16));
  }
  return groups.join(":");
}

function extractEmbeddedIPv4(address: string): string | null {
  const octets = parseIPv6(address);
  if (startsWith(octets, NAT64_WELL_KNOWN_PREFIX)) {
    return formatIPv4(octets.slice(12, 16));
  }
  if (startsWith(octets, NAT64_LOCAL_PREFIX)) {
    return formatIPv4([octets[6], octets[7], octets[9], octets[10]]);
  }
  if (startsWith(octets, SIX_TO_FOUR_PREFIX)) {
    return formatIPv4(octets.slice(2, 6));
  }
  if (startsWith(octets, IPV4_COMPATIBLE_PREFIX)) {
    const embedded = octets.slice(12, 16);
    const isUnspecified = embedded.every((octet) => octet === 0);
    const isLoopback =
      embedded[0] === 0 && embedded[1] === 0 && embedded[2] === 0 && embedded[3] === 1;
    return isUnspecified || isLoopback ? null : formatIPv4(embedded);
  }
  if (startsWith(octets, SIIT_PREFIX)) {
    return formatIPv4(octets.slice(12, 16));
  }
  return null;
}

function parseIPv6(address: string): number[] {
  const literal = address.split("%", 1)[0];
  const dottedTail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(literal);
  const expandedLiteral = dottedTail
    ? `${literal.slice(0, dottedTail.index)}${ipv4ToGroups(dottedTail[1]).join(":")}`
    : literal;
  const [left = "", right = ""] = expandedLiteral.split("::");
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const omittedGroups = 8 - leftGroups.length - rightGroups.length;
  const groups = [
    ...leftGroups,
    ...Array.from({ length: omittedGroups }, () => "0"),
    ...rightGroups,
  ];
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function ipv4ToGroups(address: string): string[] {
  const octets = address.split(".").map(Number);
  return [((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
}

function startsWith(address: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((octet, index) => address[index] === octet);
}

function formatIPv4(octets: readonly number[]): string {
  return octets.join(".");
}
