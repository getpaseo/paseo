import { useCallback, useEffect, useRef } from "react";
import { useRouter, useSegments, useUnstableGlobalHref, type Href } from "expo-router";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  useWorkspaceLayoutStore,
  useWorkspaceLayoutStoreHydrated,
} from "@/stores/workspace-layout-store";
import { collectAllTabs, findPaneById } from "@/stores/workspace-layout-actions";
import { isWeb } from "@/constants/platform";
import {
  parseHostWorkspaceRouteFromPathname,
  stripHostWorkspaceRouteEchoSearch,
} from "@/utils/host-routes";
import {
  createRouteHistory,
  normalizeRouteHistoryHref,
  type RouteHistoryDirection,
  type RouteHistoryEntry,
} from "./route-history-state";

export type { RouteHistoryDirection } from "./route-history-state";

function getWorkspaceTab(entry: RouteHistoryEntry) {
  const selection = parseHostWorkspaceRouteFromPathname(entry.href);
  if (!selection) return null;
  const workspaceKey = `${selection.serverId}:${selection.workspaceId}`;
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  return layout ? collectAllTabs(layout.root).find((tab) => tab.tabId === entry.tabId) : null;
}

function isAvailable(entry: RouteHistoryEntry): boolean {
  if (!parseHostWorkspaceRouteFromPathname(entry.href)) return true;
  return Boolean(getWorkspaceTab(entry));
}

export function useRouteHistory(): (direction: RouteHistoryDirection) => boolean {
  const router = useRouter();
  const segments = useSegments();
  const href = stripHostWorkspaceRouteEchoSearch(useUnstableGlobalHref());
  const selection = parseHostWorkspaceRouteFromPathname(href);
  const workspaceKey = selection ? `${selection.serverId}:${selection.workspaceId}` : null;
  const hydrated = useWorkspaceLayoutStoreHydrated();
  const tabId = useWorkspaceLayoutStore((state) => {
    const layout = workspaceKey ? state.layoutByWorkspace[workspaceKey] : null;
    return layout ? (findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null) : null;
  });
  const history = useRef(createRouteHistory()).current;
  const record = useCallback(() => {
    if (!isWeb) return;
    // Expo's global href can contain inherited params absent from the displayed URL.
    const url = new URL(window.location.href);
    const normalizedHref = normalizeRouteHistoryHref(url.href, segments);
    const currentHref = stripHostWorkspaceRouteEchoSearch(normalizedHref);
    const currentWorkspace = parseHostWorkspaceRouteFromPathname(currentHref);
    const currentKey = currentWorkspace
      ? `${currentWorkspace.serverId}:${currentWorkspace.workspaceId}`
      : null;
    const layout = currentKey
      ? useWorkspaceLayoutStore.getState().layoutByWorkspace[currentKey]
      : null;
    const currentTabId = layout
      ? (findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null)
      : null;
    // Bootstrap and agent resolver routes redirect; open is a one-shot intent.
    const isRedirect = /^\/$|^\/h\/[^/]+\/?$|^\/h\/[^/]+\/agent\/[^/]+\/?$/.test(url.pathname);
    if (
      isRedirect ||
      (currentKey && (!hydrated || !currentTabId || url.searchParams.has("open")))
    ) {
      return;
    }
    history.record({ href: currentHref, tabId: currentTabId });
  }, [history, hydrated, segments]);

  useEffect(() => {
    // Coalesce tab preparation with the route commit for a workspace switch.
    const timer = setTimeout(record, 0);
    return () => clearTimeout(timer);
  }, [record, href, tabId]);

  return useCallback(
    (direction: RouteHistoryDirection) => {
      record();
      const entry = history.move(direction, isAvailable);
      if (!entry) return true;
      const workspace = parseHostWorkspaceRouteFromPathname(entry.href);
      if (workspace) {
        const tab = getWorkspaceTab(entry);
        if (tab) {
          navigateToWorkspace({ ...workspace, target: tab.target });
          useWorkspaceLayoutStore
            .getState()
            .focusTab(`${workspace.serverId}:${workspace.workspaceId}`, tab.tabId);
        }
      } else {
        router.dismissTo(entry.href as Href);
      }
      return true;
    },
    [history, record, router],
  );
}
