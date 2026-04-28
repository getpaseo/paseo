// Pushes the user's auth-server session token to every connected daemon so
// the Hubcode agent provider can fetch per-user combos / API key on demand.
//
// Mounted once near the app root. The push fires whenever:
//   1. The auth session token changes (sign-in, sign-out, token refresh).
//   2. The set of hosts changes (a new daemon was added).
//   3. ANY connected daemon transitions to "online" — important because the
//      desktop daemon may still be connecting when the app first mounts; we
//      need to re-push as soon as it's reachable.

import { useEffect } from "react";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { useHosts, getHostRuntimeStore } from "@/runtime/host-runtime";
import { authServerBaseUrl } from "@/desktop/auth/web-auth-api";

export function useHubcodeAuthSync(): void {
  const { session } = useAuthSession();
  const hosts = useHosts();

  useEffect(() => {
    const token = session?.sessionToken ?? null;
    const authServerUrl = authServerBaseUrl();
    const store = getHostRuntimeStore();

    const sendToHost = (serverId: string) => {
      const client = store.getClient(serverId);
      if (!client) return;
      // Fire-and-forget: a failed push shouldn't block UI. The daemon caches
      // null gracefully, so a missing token simply disables the Hubcode
      // provider until the next sync.
      void client.setHubcodeAuthSession(token, authServerUrl).catch(() => {});
    };

    // Initial push to whichever daemons are already online.
    for (const host of hosts) sendToHost(host.serverId);

    // Subscribe to per-host snapshot changes so we re-push when a daemon
    // transitions into "online". The previous status is tracked locally so
    // we only push on the offline→online edge (avoids a flood while the
    // connection negotiates).
    const previousStatus = new Map<string, string>();
    const unsubscribers: Array<() => void> = [];
    for (const host of hosts) {
      const initial = store.getSnapshot(host.serverId);
      previousStatus.set(host.serverId, initial?.connectionStatus ?? "idle");
      const unsub = store.subscribe(host.serverId, () => {
        const snap = store.getSnapshot(host.serverId);
        if (!snap) return;
        const prev = previousStatus.get(host.serverId);
        previousStatus.set(host.serverId, snap.connectionStatus);
        if (snap.connectionStatus === "online" && prev !== "online") {
          sendToHost(host.serverId);
        }
      });
      unsubscribers.push(unsub);
    }
    return () => {
      for (const u of unsubscribers) u();
    };
  }, [session?.sessionToken, hosts]);
}
