import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { selectBrowserMirror } from "@/desktop/browser/capability";
import { useBrowserStore } from "@/desktop/browser/store";
import { useSessionStore } from "@/stores/session-store";

export type BrowserTabAnnounceClient = Pick<DaemonClient, "announceBrowserTabs">;

const ANNOUNCE_DEBOUNCE_MS = 250;

/**
 * Only this host knows which browser tabs it owns, so it tells the daemon
 * whenever its local index changes and once the daemon says it can mirror them —
 * a daemon that restarted has forgotten every tab until a host announces again.
 *
 * The mirror flag arrives with `server_info` on every connect, so gating on it
 * also covers reconnects. A daemon too old to mirror never sets it and never
 * hears an announce it has no handler for.
 */
export function mountBrowserTabAnnouncer(
  serverId: string,
  client: BrowserTabAnnounceClient,
  options?: { debounceMs?: number },
): () => void {
  const debounceMs = options?.debounceMs ?? ANNOUNCE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function announceSoon(): void {
    if (timer || !selectBrowserMirror(useSessionStore.getState(), serverId)) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      client.announceBrowserTabs();
    }, debounceMs);
  }

  const unsubscribeBrowsers = useBrowserStore.subscribe((state, previousState) => {
    if (state.browsersById !== previousState.browsersById) {
      announceSoon();
    }
  });
  const unsubscribeSession = useSessionStore.subscribe((state, previousState) => {
    const hasMirror = selectBrowserMirror(state, serverId);
    if (hasMirror && !selectBrowserMirror(previousState, serverId)) {
      announceSoon();
    }
  });
  announceSoon();

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    unsubscribeBrowsers();
    unsubscribeSession();
  };
}
