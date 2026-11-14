import os, { type NetworkInterfaceInfo } from "node:os";
import type { AddressInfo } from "node:net";

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [first, second] = parts;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

/** Report only private IPv4 interfaces on which this daemon's TCP listener can accept traffic. */
export function reachableDirectEndpoints(params: {
  boundAddress: AddressInfo | string | null;
  interfaces?: Interfaces;
}): string[] {
  const { boundAddress } = params;
  if (!boundAddress || typeof boundAddress === "string") return [];
  const { address, port } = boundAddress;
  if (!port || port < 1 || port > 65535) return [];
  const interfaces = params.interfaces ?? os.networkInterfaces();
  const wildcard = address === "0.0.0.0" || address === "::";
  const addresses = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || !isPrivateIpv4(entry.address)) continue;
      if (!wildcard && entry.address !== address) continue;
      addresses.add(`${entry.address}:${port}`);
    }
  }
  return [...addresses].sort();
}
