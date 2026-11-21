import type {
  NavigationAction,
  NavigationContainerRef,
  NavigationContainerRefWithCurrent,
} from "expo-router/react-navigation";
import { router, type Href } from "expo-router";
import {
  encodeWorkspaceIdForPathSegment,
  getHostWorkspaceOpenParamFromPathname,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";

const ROOT_HOST_ROUTE_NAME = "h/[serverId]";
const HOST_WORKSPACE_ROUTE_NAME = "workspace/[workspaceId]/index";

interface NavigateToHostWorkspaceRouteDeps {
  dismissTo(route: string): void;
}

const defaultNavigateToHostWorkspaceRouteDeps: NavigateToHostWorkspaceRouteDeps = {
  dismissTo: (route) => router.dismissTo(route as Href),
};

interface NavigateToHostLeafDeps {
  push(route: string): void;
}

const defaultNavigateToHostLeafDeps: NavigateToHostLeafDeps = {
  push: (route) => router.push(route as Href),
};

/** A screen of the host stack, named the way `h/[serverId]/_layout.tsx` registers it. */
export interface HostLeafTarget {
  /** The full `/h/...` URL, used when no covered host route can take the leaf. */
  route: string;
  serverId: string;
  screen: string;
  params: Record<string, string>;
}

type NavigationIntent = (navigation: NavigationContainerRef<ReactNavigation.RootParamList>) => void;

let rootNavigationRef: NavigationContainerRefWithCurrent<ReactNavigation.RootParamList> | null =
  null;
let pendingIntent: NavigationIntent | null = null;

export function registerWorkspaceRouteNavigationRef(
  ref: NavigationContainerRefWithCurrent<ReactNavigation.RootParamList>,
): () => void {
  rootNavigationRef = ref;
  const unsubscribe = ref.addListener("ready", flushPendingIntent);
  flushPendingIntent();
  return () => {
    unsubscribe();
    if (rootNavigationRef === ref) {
      rootNavigationRef = null;
    }
  };
}

interface MountedRouteStack {
  key: string;
  focusedRouteName: string | null;
}

function findStackWithMountedRouteName(
  state: unknown,
  routeName: string,
): MountedRouteStack | null {
  if (!state || typeof state !== "object") {
    return null;
  }

  const candidate = state as {
    index?: unknown;
    key?: unknown;
    routes?: unknown;
  };

  if (!Array.isArray(candidate.routes)) {
    return null;
  }

  if (
    typeof candidate.key === "string" &&
    candidate.routes.some(
      (route) =>
        !!route && typeof route === "object" && (route as { name?: unknown }).name === routeName,
    )
  ) {
    const focusedIndex =
      typeof candidate.index === "number" &&
      Number.isInteger(candidate.index) &&
      candidate.index >= 0 &&
      candidate.index < candidate.routes.length
        ? candidate.index
        : candidate.routes.length - 1;
    const focusedRoute = candidate.routes[focusedIndex];
    const focusedRouteName =
      focusedRoute && typeof focusedRoute === "object"
        ? (focusedRoute as { name?: unknown }).name
        : null;
    return {
      key: candidate.key,
      focusedRouteName: typeof focusedRouteName === "string" ? focusedRouteName : null,
    };
  }

  for (const route of candidate.routes) {
    if (!route || typeof route !== "object") {
      continue;
    }
    const childStack = findStackWithMountedRouteName(
      (route as { state?: unknown }).state,
      routeName,
    );
    if (childStack) {
      return childStack;
    }
  }

  return null;
}

/**
 * The stack holding a host route that an app-wide route (History, Settings, New) covers. Pushing a
 * `/h/...` URL from there appends a second host route instead of reusing this one; the covered copy
 * stays mounted and still reads the current pathname.
 */
function findCoveredHostStack(
  navigation: NavigationContainerRef<ReactNavigation.RootParamList>,
): MountedRouteStack | null {
  const hostStack = findStackWithMountedRouteName(navigation.getRootState(), ROOT_HOST_ROUTE_NAME);
  if (!hostStack || hostStack.focusedRouteName === ROOT_HOST_ROUTE_NAME) {
    return null;
  }
  return hostStack;
}

function dispatchHostLeafPopTo(
  leaf: HostLeafTarget,
  navigation: NavigationContainerRef<ReactNavigation.RootParamList>,
): boolean {
  const hostStack = findCoveredHostStack(navigation);
  if (!hostStack) {
    return false;
  }
  // No `pop` hint: the leaf is pushed onto the host stack, so Back returns to the workspace.
  navigation.dispatch({
    type: "POP_TO",
    target: hostStack.key,
    payload: {
      name: ROOT_HOST_ROUTE_NAME,
      params: {
        serverId: leaf.serverId,
        screen: leaf.screen,
        params: { serverId: leaf.serverId, ...leaf.params },
      },
    },
  });
  return true;
}

function dispatchHostWorkspacePopTo(
  route: string,
  navigation: NavigationContainerRef<ReactNavigation.RootParamList>,
): boolean {
  const selection = parseHostWorkspaceRouteFromPathname(route);
  if (!selection) {
    return false;
  }

  const hostStack = findCoveredHostStack(navigation);
  if (!hostStack) {
    return false;
  }
  const open = getHostWorkspaceOpenParamFromPathname(route);

  const action: NavigationAction = {
    type: "POP_TO",
    target: hostStack.key,
    payload: {
      name: ROOT_HOST_ROUTE_NAME,
      params: {
        serverId: selection.serverId,
        screen: HOST_WORKSPACE_ROUTE_NAME,
        params: {
          serverId: selection.serverId,
          workspaceId: encodeWorkspaceIdForPathSegment(selection.workspaceId),
          ...(open ? { open } : {}),
        },
        // React Navigation consumes this nested hint when resolving the host child screen.
        // The browser-route canonicalizer strips the resulting ?pop=true URL artifact.
        // Removing it lets repeated /new -> workspace hops append hidden deck entries.
        pop: true,
      },
    },
  };
  navigation.dispatch(action);
  return true;
}

export function navigateToHostWorkspaceRoute(
  route: string,
  deps: NavigateToHostWorkspaceRouteDeps = defaultNavigateToHostWorkspaceRouteDeps,
): void {
  pendingIntent = (navigation) => {
    if (!dispatchHostWorkspacePopTo(route, navigation)) deps.dismissTo(route);
  };
  flushPendingIntent();
}

/**
 * Opens a host screen other than a workspace, such as a plugin screen. From an app-wide route it
 * pops to the mounted host route and pushes the leaf there; otherwise it pushes the URL.
 */
export function navigateToHostLeaf(
  leaf: HostLeafTarget,
  deps: NavigateToHostLeafDeps = defaultNavigateToHostLeafDeps,
): void {
  pendingIntent = (navigation) => {
    if (!dispatchHostLeafPopTo(leaf, navigation)) deps.push(leaf.route);
  };
  flushPendingIntent();
}

function flushPendingIntent(): void {
  const navigation = rootNavigationRef?.current;
  if (!pendingIntent || !navigation?.isReady()) return;

  const intent = pendingIntent;
  pendingIntent = null;
  intent(navigation);
}
