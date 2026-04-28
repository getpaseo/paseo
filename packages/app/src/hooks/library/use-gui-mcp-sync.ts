import { useEffect, useMemo } from "react";
import { useHosts, useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { LibraryEntry } from "@/api/library";

/**
 * Push MCP library entries flagged with the `hubcode-gui` sync target to the
 * daemon's GUI MCP registry so they are injected into new Claude SDK
 * sessions. Runs whenever the installed list changes and on daemon reconnect.
 *
 * Why not auth-server → daemon direct: the daemon doesn't hold the user's
 * auth session; the app is the trusted cache. Republishing on every change
 * is cheap (small payload) and keeps the daemon stateless across restarts.
 */
export function useGuiMcpSync(installedMcp: LibraryEntry[] | undefined) {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? "";
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);

  const guiEntries = useMemo(() => {
    const list = installedMcp ?? [];
    return list
      .filter((e) => e.activation?.active && e.activation.syncTargets.includes("hubcode-gui"))
      .map((e) => ({ name: e.name, payload: e.payload }));
  }, [installedMcp]);

  // Stable key so we only re-push when something actually changed.
  const fingerprint = useMemo(() => JSON.stringify(guiEntries), [guiEntries]);

  useEffect(() => {
    if (!client || !connected) return;
    void client.libraryMcpGuiSync(guiEntries).catch(() => {
      // Daemon may not support this RPC on older builds — silent.
    });
  }, [client, connected, fingerprint, guiEntries]);
}
