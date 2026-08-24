import { parseHostAgentRouteFromPathname } from "@/utils/host-routes";

/**
 * App-level back/forward view history, driven by the desktop app's mouse
 * back/forward buttons.
 *
 * Why this exists: in-app navigation mostly uses dismissTo()/replace(), so
 * browser history almost never accumulates entries (history.length stays 1)
 * and Chromium's built-in mouse-button navigation has nothing to walk. This
 * tracker records committed pathnames and answers "where was I before" —
 * Slack-style previous/next view.
 */
export interface ViewHistoryTracker {
  /** Record a newly committed pathname as the current view. */
  record(pathname: string): void;
  /** Move back; returns the pathname to show, or null at the oldest entry. */
  goBack(): string | null;
  /** Move forward; returns the pathname to show, or null at the newest entry. */
  goForward(): string | null;
}

export function createViewHistoryTracker(): ViewHistoryTracker {
  let entries: string[] = [];
  let index = -1;

  return {
    record(pathname) {
      if (index >= 0 && entries[index] === pathname) return;
      // A fresh view after going back truncates the forward stack, matching
      // browser history semantics.
      entries = entries.slice(0, index + 1);
      entries.push(pathname);
      index = entries.length - 1;
    },
    goBack() {
      if (index <= 0) return null;
      index -= 1;
      return entries[index] ?? null;
    },
    goForward() {
      if (index >= entries.length - 1) return null;
      index += 1;
      return entries[index] ?? null;
    },
  };
}

/**
 * Routes that bounce straight through to somewhere else: the startup chooser
 * (/), the host index (restores the remembered workspace), and the agent
 * detail route (resolves then redirects into the workspace). Recording them
 * would make "back" land on a redirect that flings you forward again.
 */
export function shouldRecordPathname(pathname: string): boolean {
  if (pathname === "/") return false;
  if (/^\/h\/[^/]+\/?$/.test(pathname)) return false;
  if (parseHostAgentRouteFromPathname(pathname)) return false;
  return true;
}
