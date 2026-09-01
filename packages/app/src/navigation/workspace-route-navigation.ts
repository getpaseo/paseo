import type { NavigationAction, NavigationContainerRefWithCurrent } from "@react-navigation/native";
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

let rootNavigationRef: NavigationContainerRefWithCurrent<ReactNavigation.RootParamList> | null =
  null;

export function registerWorkspaceRouteNavigationRef(
  ref: NavigationContainerRefWithCurrent<ReactNavigation.RootParamList>,
): () => void {
  rootNavigationRef = ref;
  return () => {
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

function dispatchHostWorkspacePopTo(route: string): boolean {
  const selection = parseHostWorkspaceRouteFromPathname(route);
  const navigation = rootNavigationRef?.current;
  if (!selection || !navigation?.isReady()) {
    return false;
  }

  const rootState = navigation.getRootState();
  const hostStack = findStackWithMountedRouteName(rootState, ROOT_HOST_ROUTE_NAME);
  if (!hostStack || hostStack.focusedRouteName === ROOT_HOST_ROUTE_NAME) {
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
  if (dispatchHostWorkspacePopTo(route)) {
    return;
  }

  deps.dismissTo(route);
}
