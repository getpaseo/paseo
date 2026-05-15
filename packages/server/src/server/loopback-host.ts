import net from "node:net";

const LOOPBACK_IP_HOSTS = new net.BlockList();
LOOPBACK_IP_HOSTS.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_IP_HOSTS.addAddress("::1", "ipv6");

function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function isLoopbackHost(host: string): boolean {
  const normalizedHost = normalizeHost(host);
  if (normalizedHost === "localhost") return true;
  if (normalizedHost.endsWith(".localhost")) return true;

  const ipVersion = net.isIP(normalizedHost);
  if (ipVersion === 4) {
    return LOOPBACK_IP_HOSTS.check(normalizedHost, "ipv4");
  }
  if (ipVersion === 6) {
    return LOOPBACK_IP_HOSTS.check(normalizedHost, "ipv6");
  }
  return false;
}
