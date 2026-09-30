import { getHostRuntimeStore } from "@/runtime/host-runtime";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * An agent's localhost URL means the daemon's machine; a client elsewhere reaches that machine
 * on the host address it is connected to. Other URLs, and clients on the daemon's own machine,
 * keep the URL as it is.
 */
export function rewriteLoopbackUrl(url: string, hostEndpoint: string | null): string {
  if (!hostEndpoint) return url;
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return url;
    if (!LOOPBACK_HOSTS.has(target.hostname)) return url;
    const hostname = new URL(`http://${hostEndpoint}`).hostname;
    if (LOOPBACK_HOSTS.has(hostname)) return url;
    target.hostname = hostname;
    const rewritten = target.toString();
    // URL adds a trailing slash to a bare origin; keep what the agent wrote.
    return url.endsWith("/") || !rewritten.endsWith("/") ? rewritten : rewritten.slice(0, -1);
  } catch {
    return url;
  }
}

/** The host:port a direct connection to this server uses, or null for relay, SSH and sockets. */
export function directHostEndpoint(serverId: string | null | undefined): string | null {
  if (!serverId) return null;
  const connection = getHostRuntimeStore().getSnapshot(serverId)?.activeConnection;
  return connection?.type === "directTcp" ? connection.endpoint : null;
}
