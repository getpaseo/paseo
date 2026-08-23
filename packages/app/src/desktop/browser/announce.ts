import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useBrowserStore } from "@/desktop/browser/store";

export type BrowserTabAnnounceClient = Pick<
  DaemonClient,
  "announceBrowserTabs" | "subscribeConnectionStatus"
>;

const ANNOUNCE_DEBOUNCE_MS = 250;

/**
 * Only this host knows which browser tabs it owns, so it tells the daemon
 * whenever its local index changes and once per connect — a daemon that
 * restarted has forgotten every tab until a host announces again.
 */
export function mountBrowserTabAnnouncer(
  client: BrowserTabAnnounceClient,
  options?: { debounceMs?: number },
): () => void {
  const debounceMs = options?.debounceMs ?? ANNOUNCE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function announceSoon(): void {
    if (timer) {
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
  const unsubscribeConnection = client.subscribeConnectionStatus((connectionState) => {
    if (connectionState.status === "connected") {
      announceSoon();
    }
  });

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    unsubscribeBrowsers();
    unsubscribeConnection();
  };
}
