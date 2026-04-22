import { useMemo, useSyncExternalStore } from "react";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/shim/with-selector";
import {
  buildHostWorkspaceRoute,
  decodeWorkspaceIdFromPathSegment,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import { isWeb } from "@/constants/platform";

export interface ActiveWorkspaceSelection {
  serverId: string;
  workspaceId: string;
}

interface ActivateWorkspaceSelectionOptions {
  updateBrowserHistory?: boolean;
  historyMode?: "push" | "replace";
}

type NavigationRouteParams = {
  serverId?: string | string[];
  workspaceId?: string | string[];
};

type NavigationRouteLike = {
  params?: NavigationRouteParams | null;
  path?: string | null;
};

type NavigationWorkspaceRouteState =
  | { kind: "workspace"; selection: ActiveWorkspaceSelection }
  | { kind: "nonWorkspace" }
  | { kind: "unknown" };

interface NavigationObserverRef {
  current: {
    getCurrentRoute(): NavigationRouteLike | null | undefined;
  } | null;
}

let snapshot: ActiveWorkspaceSelection | null = null;
let lastWorkspaceRouteSelection: ActiveWorkspaceSelection | null = null;
let nextWorkspaceRouteSelectionOverride: ActiveWorkspaceSelection | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ActiveWorkspaceSelection | null {
  return snapshot;
}

function emitIfChanged(next: ActiveWorkspaceSelection | null) {
  if (snapshot?.serverId === next?.serverId && snapshot?.workspaceId === next?.workspaceId) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function getBrowserLocationWorkspace(): ActiveWorkspaceSelection | null {
  if (!isWeb || typeof window === "undefined") {
    return null;
  }
  return parseHostWorkspaceRouteFromPathname(window.location.pathname);
}

function writeBrowserWorkspaceUrl(
  next: ActiveWorkspaceSelection,
  options: ActivateWorkspaceSelectionOptions,
) {
  if (!options.updateBrowserHistory || !isWeb || typeof window === "undefined") {
    return;
  }

  const nextPath = buildHostWorkspaceRoute(next.serverId, next.workspaceId);
  const currentUrl = new URL(window.location.href);
  if (currentUrl.pathname === nextPath && !currentUrl.search && !currentUrl.hash) {
    return;
  }

  const nextUrl = new URL(nextPath, window.location.origin);
  const mode = options.historyMode ?? "push";
  if (mode === "replace") {
    window.history.replaceState(null, "", nextUrl.toString());
    return;
  }
  window.history.pushState(null, "", nextUrl.toString());
}

function extractActiveWorkspaceFromRoute(
  route: NavigationRouteLike | null | undefined,
): ActiveWorkspaceSelection | null {
  if (!route) {
    return null;
  }

  if (typeof route.path === "string") {
    const parsed = parseHostWorkspaceRouteFromPathname(route.path);
    if (parsed) {
      return parsed;
    }
  }

  const serverValue = Array.isArray(route.params?.serverId)
    ? route.params.serverId[0]
    : route.params?.serverId;
  const workspaceValue = Array.isArray(route.params?.workspaceId)
    ? route.params.workspaceId[0]
    : route.params?.workspaceId;
  const serverId = typeof serverValue === "string" ? serverValue.trim() : "";
  const workspaceId =
    typeof workspaceValue === "string"
      ? (decodeWorkspaceIdFromPathSegment(workspaceValue) ?? "")
      : "";

  if (!serverId || !workspaceId) {
    return null;
  }

  return { serverId, workspaceId };
}

function classifyNavigationWorkspaceRoute(
  route: NavigationRouteLike | null | undefined,
): NavigationWorkspaceRouteState {
  if (!route) {
    return { kind: "unknown" };
  }

  if (typeof route.path === "string") {
    const selection = parseHostWorkspaceRouteFromPathname(route.path);
    if (selection) {
      return { kind: "workspace", selection };
    }
    return { kind: "nonWorkspace" };
  }

  const selection = extractActiveWorkspaceFromRoute(route);
  if (selection) {
    return { kind: "workspace", selection };
  }

  return { kind: "unknown" };
}

function getActiveWorkspaceForNavigationSync(
  route: NavigationRouteLike | null | undefined,
): ActiveWorkspaceSelection | null {
  const routeState = classifyNavigationWorkspaceRoute(route);
  if (routeState.kind === "workspace") {
    const browserWorkspace = getBrowserLocationWorkspace();
    return browserWorkspace ?? routeState.selection;
  }

  if (routeState.kind === "nonWorkspace") {
    return null;
  }

  return getBrowserLocationWorkspace();
}

export function syncNavigationActiveWorkspace(navigationRef: NavigationObserverRef) {
  const route = navigationRef.current?.getCurrentRoute();
  const routeState = classifyNavigationWorkspaceRoute(route);
  if (routeState.kind === "workspace") {
    lastWorkspaceRouteSelection = routeState.selection;
    if (nextWorkspaceRouteSelectionOverride) {
      const overrideSelection = nextWorkspaceRouteSelectionOverride;
      nextWorkspaceRouteSelectionOverride = null;
      emitIfChanged(overrideSelection);
      return;
    }
  }
  emitIfChanged(getActiveWorkspaceForNavigationSync(route));
}

export function activateNavigationWorkspaceSelection(
  next: ActiveWorkspaceSelection,
  options: ActivateWorkspaceSelectionOptions = {},
) {
  writeBrowserWorkspaceUrl(next, options);
  emitIfChanged(next);
}

export function getNavigationActiveWorkspaceSelection(): ActiveWorkspaceSelection | null {
  return getSnapshot();
}

export function getLastNavigationWorkspaceRouteSelection(): ActiveWorkspaceSelection | null {
  return lastWorkspaceRouteSelection;
}

export function overrideNextNavigationWorkspaceRouteSelection(next: ActiveWorkspaceSelection) {
  nextWorkspaceRouteSelectionOverride = next;
}

export function syncBrowserActiveWorkspaceFromLocation() {
  emitIfChanged(getBrowserLocationWorkspace());
}

export function addBrowserActiveWorkspaceLocationListener(): () => void {
  if (!isWeb || typeof window === "undefined") {
    return () => {};
  }

  const handlePopState = () => {
    syncBrowserActiveWorkspaceFromLocation();
  };
  window.addEventListener("popstate", handlePopState);
  return () => {
    window.removeEventListener("popstate", handlePopState);
  };
}

export function useNavigationActiveWorkspaceSelection(): ActiveWorkspaceSelection | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useIsNavigationWorkspaceSelected(input: {
  serverId: string | null;
  workspaceId: string | null;
  enabled?: boolean;
}): boolean {
  const enabled = input.enabled !== false;
  return useSyncExternalStoreWithSelector(
    subscribe,
    getSnapshot,
    getSnapshot,
    (selection) =>
      enabled &&
      Boolean(input.serverId) &&
      Boolean(input.workspaceId) &&
      selection?.serverId === input.serverId &&
      selection.workspaceId === input.workspaceId,
    Object.is,
  );
}

export function useIsNavigationProjectActive(input: {
  serverId: string | null;
  workspaceIds: readonly string[];
  enabled?: boolean;
}): boolean {
  const enabled = input.enabled !== false;
  const workspaceIdsKey = input.workspaceIds.join("\0");
  const workspaceIdSet = useMemo(() => new Set(input.workspaceIds), [workspaceIdsKey]);

  return useSyncExternalStoreWithSelector(
    subscribe,
    getSnapshot,
    getSnapshot,
    (selection) =>
      enabled &&
      Boolean(input.serverId) &&
      selection?.serverId === input.serverId &&
      workspaceIdSet.has(selection.workspaceId),
    Object.is,
  );
}
