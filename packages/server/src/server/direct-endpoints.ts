import os, { type NetworkInterfaceInfo } from "node:os";

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
export function reachableDirectEndpoints(
  listenHost: string | null,
  port: number | null,
  interfaces: Interfaces = os.networkInterfaces(),
): string[] {
  if (!listenHost || !port || port < 1 || port > 65535) return [];
  const wildcard = listenHost === "0.0.0.0" || listenHost === "::";
  const addresses = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || !isPrivateIpv4(entry.address)) continue;
      if (!wildcard && entry.address !== listenHost) continue;
      addresses.add(`${entry.address}:${port}`);
    }
  }
  return [...addresses].sort();
}
