import { useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import { useHosts } from "@/runtime/host-runtime";

/**
 * The host setup configures: the desktop's built-in daemon, otherwise the first saved host.
 * Null while the desktop daemon is still reporting its id, or when there is no host at all.
 */
export function useSetupHostServerId(): string | null {
  const localDaemon = useLocalDaemonServerIdState();
  const hosts = useHosts();
  if (localDaemon.status === "loading") return null;
  if (localDaemon.status === "resolved" && localDaemon.serverId) return localDaemon.serverId;
  return hosts[0]?.serverId ?? null;
}
