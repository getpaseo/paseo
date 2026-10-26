import { createStore } from "zustand/vanilla";

interface SettingsRouteEntry {
  key: string;
  pathname: string;
}

interface SettingsSelectionState {
  selectedServerId: string | null;
}

export function createSettingsSelection() {
  const store = createStore<SettingsSelectionState>(() => ({ selectedServerId: null }));
  const enteredRoutes = new Map<string, string>();
  let inSettings = false;

  function enterRoute(
    { key, pathname }: SettingsRouteEntry,
    workspaceServerId: string | null,
  ): void {
    const isSettings = pathname === "/settings" || pathname.startsWith("/settings/");
    if (!isSettings) {
      inSettings = false;
      enteredRoutes.clear();
      return;
    }
    // A retained route returning through Back must not replay its old host intent.
    if (enteredRoutes.get(key) === pathname) return;
    const isNewVisit = !inSettings;
    inSettings = true;
    enteredRoutes.set(key, pathname);

    const hostMatch = /^\/settings\/hosts\/([^/]+)(?:\/|$)/.exec(pathname);
    if (hostMatch) {
      store.setState({ selectedServerId: decodeURIComponent(hostMatch[1]) });
    } else if (isNewVisit) {
      store.setState({ selectedServerId: workspaceServerId });
    }
  }

  function selectHost(serverId: string): void {
    store.setState({ selectedServerId: serverId });
  }

  return { store, enterRoute, selectHost };
}
