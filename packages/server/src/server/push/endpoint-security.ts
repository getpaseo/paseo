import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface EndpointResolution {
  resolveHost(hostname: string): Promise<string[]>;
}

const defaultResolution: EndpointResolution = {
  async resolveHost(hostname) {
    const results = await lookup(hostname, { all: true });
    return results.map((result) => result.address);
  },
};

export function createEndpointLogContext(endpoint: string): {
  endpointHost: string;
  endpointHash: string;
} {
  const url = new URL(endpoint);
  return {
    endpointHost: url.hostname,
    endpointHash: createHash("sha256").update(endpoint).digest("hex").slice(0, 12),
  };
}

export function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  return !isBlockedIpv4Range(a, b);
}

function isBlockedIpv4Range(a: number, b: number): boolean {
  const blockedFirstOctets = new Set([0, 10, 127]);
  if (blockedFirstOctets.has(a)) return true;
  const blockedRanges: Array<(first: number, second: number) => boolean> = [
    (first, second) => first === 100 && second >= 64 && second <= 127,
    (first, second) => first === 169 && second === 254,
    (first, second) => first === 172 && second >= 16 && second <= 31,
    (first, second) => first === 192 && (second === 0 || second === 168),
    (first, second) => first === 198 && (second === 18 || second === 19),
    (first) => first >= 224,
  ];
  return blockedRanges.some((isBlocked) => isBlocked(a, b));
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return false;
  }
  if (normalized.startsWith("ff")) return false;
  return true;
}

export async function assertSafeWebPushEndpoint(
  endpoint: string,
  resolution: EndpointResolution = defaultResolution,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Invalid Web Push endpoint URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Web Push endpoint must use HTTPS");
  }

  const addresses = await resolution.resolveHost(url.hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
    throw new Error("Web Push endpoint resolves to a non-public address");
  }

  return url;
}
