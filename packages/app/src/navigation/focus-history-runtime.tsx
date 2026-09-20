import { useEffect, useMemo, useSyncExternalStore } from "react";
import { BackHandler } from "react-native";
import { router, type Href, usePathname } from "expo-router";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import {
  collectAllTabs,
  findPaneById,
  type WorkspaceLayout,
  useWorkspaceLayoutStore,
  useWorkspaceLayoutStoreHydrated,
} from "@/stores/workspace-layout-store";
import { usePanelStore } from "@/stores/panel-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";
import {
  navigationFocusHistory,
  type NavigationFocusLocation,
  type NavigationViewState,
  type WorkspaceFocusLocation,
} from "./focus-history";

const TRACKED_APP_ROUTE_PREFIXES = [
  "/settings",
  "/new",
  "/open-project",
  "/sessions",
  "/schedules",
  "/pair-scan",
] as const;

export function buildWorkspaceFocusLocation(input: {
  serverId: string;
  workspaceId: string;
  layout: WorkspaceLayout | null;
  view: NavigationViewState;
}): WorkspaceFocusLocation {
  const pane = input.layout ? findPaneById(input.layout.root, input.layout.focusedPaneId) : null;
  const tab =
    input.layout && pane?.focusedTabId
      ? (collectAllTabs(input.layout.root).find(
          (candidate) => candidate.tabId === pane.focusedTabId,
        ) ?? null)
      : null;
  return {
    kind: "workspace",
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    paneId: pane?.id ?? null,
    tabId: tab?.tabId ?? null,
    target: tab?.target ?? null,
    view: input.view,
  };
}

function getTrackableRouteLocation(pathname: string): NavigationFocusLocation | null {
  if (!TRACKED_APP_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }
  return { kind: "route", pathname };
}

function resolveNavigationPanel(input: {
  isCompact: boolean;
  mobilePanel: NavigationViewState["panel"];
  desktopExplorerOpen: boolean;
}): NavigationViewState["panel"] {
  if (input.isCompact) {
    // The agent list is transient navigation chrome. Selecting a workspace from
    // it should return to the prior workspace, not reopen the drawer first.
    return input.mobilePanel === "agent-list" ? "agent" : input.mobilePanel;
  }
  return input.desktopExplorerOpen ? "file-explorer" : "agent";
}

export interface RestoreNavigationFocusLocationDeps {
  navigateWorkspace: typeof navigateToWorkspace;
  navigateRoute: (pathname: string) => void;
  focusPane: (workspaceKey: string, paneId: string) => void;
  focusTab: (workspaceKey: string, tabId: string) => void;
  restoreView: (view: NavigationViewState) => void;
}

export function restoreNavigationFocusLocation(
  location: NavigationFocusLocation,
  deps: RestoreNavigationFocusLocationDeps,
): void {
  if (location.kind === "route") {
    deps.navigateRoute(location.pathname);
    return;
  }

  deps.navigateWorkspace({
    serverId: location.serverId,
    workspaceId: location.workspaceId,
    ...(location.target ? { target: location.target } : {}),
  });

  const workspaceKey = buildWorkspaceTabPersistenceKey(location);
  if (workspaceKey && location.tabId) {
    deps.focusTab(workspaceKey, location.tabId);
  } else if (workspaceKey && location.paneId) {
    deps.focusPane(workspaceKey, location.paneId);
  }
  deps.restoreView(location.view);
}

export function navigateBackInFocusHistory(input: { isCompact: boolean }): boolean {
  const location = navigationFocusHistory.back();
  if (!location) {
    return false;
  }

  try {
    const workspaceLayout = useWorkspaceLayoutStore.getState();
    restoreNavigationFocusLocation(location, {
      navigateWorkspace: navigateToWorkspace,
      navigateRoute: (pathname) => router.navigate(pathname as Href),
      focusPane: workspaceLayout.focusPane,
      focusTab: workspaceLayout.focusTab,
      restoreView: (view) =>
        usePanelStore.getState().restoreNavigationView({
          isCompact: input.isCompact,
          ...view,
        }),
    });
    return true;
  } catch {
    navigationFocusHistory.cancelRestore();
    return false;
  }
}

export function useCanNavigateBackInFocusHistory(): boolean {
  return useSyncExternalStore(
    navigationFocusHistory.subscribe,
    () => navigationFocusHistory.getSnapshot().canGoBack,
    () => navigationFocusHistory.getSnapshot().canGoBack,
  );
}

export function useNavigationFocusHistoryTracker({ enabled }: { enabled: boolean }): void {
  const pathname = usePathname();
  const isCompact = useIsCompactFormFactor();
  const hasHydratedWorkspaceLayoutStore = useWorkspaceLayoutStoreHydrated();
  const workspaceSelection = useMemo(
    () => parseHostWorkspaceRouteFromPathname(pathname),
    [pathname],
  );
  const workspaceKey = workspaceSelection
    ? buildWorkspaceTabPersistenceKey(workspaceSelection)
    : null;
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? (state.layoutByWorkspace[workspaceKey] ?? null) : null,
  );
  const mobilePanel = usePanelStore((state) => state.mobilePanel.target);
  const desktopExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const view = useMemo<NavigationViewState>(
    () => ({
      panel: resolveNavigationPanel({ isCompact, mobilePanel, desktopExplorerOpen }),
      explorerTab,
    }),
    [desktopExplorerOpen, explorerTab, isCompact, mobilePanel],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (workspaceSelection) {
      if (!hasHydratedWorkspaceLayoutStore) {
        return;
      }
      navigationFocusHistory.record(
        buildWorkspaceFocusLocation({
          ...workspaceSelection,
          layout,
          view,
        }),
      );
      return;
    }

    const routeLocation = getTrackableRouteLocation(pathname);
    if (routeLocation) {
      navigationFocusHistory.record(routeLocation);
    }
  }, [enabled, hasHydratedWorkspaceLayoutStore, layout, pathname, view, workspaceSelection]);
}

export function useNativeNavigationBackHandler({ enabled }: { enabled: boolean }): void {
  const isCompact = useIsCompactFormFactor();
  const mobilePanel = usePanelStore((state) => state.mobilePanel.target);
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);

  useEffect(() => {
    if (!enabled || !isNative) {
      return;
    }
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isCompact && mobilePanel === "agent-list") {
        showMobileAgent();
        return true;
      }
      return navigateBackInFocusHistory({ isCompact });
    });
    return () => subscription.remove();
  }, [enabled, isCompact, mobilePanel, showMobileAgent]);
}
