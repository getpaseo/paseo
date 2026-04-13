import { useSyncExternalStore } from "react";
import {
  decodeWorkspaceIdFromPathSegment,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";

interface ActiveWorkspaceSelection {
  serverId: string;
  workspaceId: string;
}

type NavigationRouteLike = {
  name?: unknown;
  params?: unknown;
  path?: unknown;
};

interface NavigationObserverRef {
  current: {
    getCurrentRoute(): unknown;
  } | null;
}

let snapshot: ActiveWorkspaceSelection | null = null;
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

function extractActiveWorkspaceFromRoute(
  route: NavigationRouteLike | undefined,
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

  const params =
    route.params && typeof route.params === "object"
      ? (route.params as {
          serverId?: string | string[];
          workspaceId?: string | string[];
        })
      : null;
  const serverValue = Array.isArray(params?.serverId) ? params?.serverId[0] : params?.serverId;
  const workspaceValue = Array.isArray(params?.workspaceId)
    ? params?.workspaceId[0]
    : params?.workspaceId;
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

export function syncNavigationActiveWorkspace(navigationRef: NavigationObserverRef) {
  emitIfChanged(
    extractActiveWorkspaceFromRoute(
      navigationRef.current?.getCurrentRoute() as NavigationRouteLike | undefined,
    ),
  );
}

export function useNavigationActiveWorkspaceSelection(): ActiveWorkspaceSelection | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
