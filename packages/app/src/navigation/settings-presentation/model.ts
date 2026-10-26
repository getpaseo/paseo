import { createStore } from "zustand/vanilla";

interface SettingsRouteEntry {
  key: string;
  pathname: string;
}

interface SettingsSelectionState {
  selectedServerId: string | null;
}

export function createSettingsPresentation() {
  const store = createStore<SettingsSelectionState>(() => ({ selectedServerId: null }));
  const enteredRoutes = new Map<string, string>();
  let inSettings = false;
  let sidebarOffset = 0;
  let sidebarOwner: object | null = null;

  function attachSidebar() {
    const owner = {};
    sidebarOwner = owner;
    return {
      get offset() {
        return sidebarOffset;
      },
      remember(offset: number) {
        if (sidebarOwner === owner) sidebarOffset = offset;
      },
      detach() {
        if (sidebarOwner === owner) sidebarOwner = null;
      },
    };
  }

  function enterRoute(
    { key, pathname }: SettingsRouteEntry,
    workspaceServerId: string | null,
  ): void {
    const isSettings = pathname === "/settings" || pathname.startsWith("/settings/");
    if (!isSettings) {
      sidebarOffset = 0;
      sidebarOwner = null;
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

  return { store, enterRoute, selectHost, attachSidebar };
}
