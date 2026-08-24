import { getIsElectron } from "@/constants/platform";
import { useSessionStore, type SessionStoreState } from "@/stores/session-store";

/**
 * The one place the browser mirror capability is detected. A daemon advertises
 * it only while a host that can serve a screencast and take viewport input is
 * connected, so everything downstream — announcing tabs, listing them, opening
 * a mirror pane — reads this and nothing else.
 */
export function selectBrowserMirror(
  state: Pick<SessionStoreState, "sessions">,
  serverId: string,
): boolean {
  return state.sessions[serverId]?.serverInfo?.features?.browserMirror === true;
}

export function useBrowserMirror(serverId: string): boolean {
  return useSessionStore((state) => selectBrowserMirror(state, serverId));
}

/**
 * Whether this client offers "new browser tab" at all.
 *
 * COMPAT(browserMirror): added in v0.5.2, remove after 2027-09-01 once the daemon
 * floor >= v0.5.2. An older daemon advertises no mirror, and Electron's local
 * browser predates mirroring and still works against it, so the desktop app
 * keeps offering tabs there. Delete the `getIsElectron()` branch and this
 * comment together.
 */
export function useCanOpenBrowserTabs(serverId: string): boolean {
  const hasMirror = useBrowserMirror(serverId);
  return hasMirror || getIsElectron();
}
