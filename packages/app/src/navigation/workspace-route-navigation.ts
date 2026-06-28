import type { NavigationAction, NavigationContainerRefWithCurrent } from "@react-navigation/native";
import { router, type Href } from "expo-router";
import {
  encodeWorkspaceIdForPathSegment,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";

const ROOT_HOST_ROUTE_NAME = "h/[serverId]";
const HOST_WORKSPACE_ROUTE_NAME = "workspace/[workspaceId]/index";

let rootNavigationRef: NavigationContainerRefWithCurrent<ReactNavigation.RootParamList> | null =
  null;

interface NavigateToHostWorkspaceRouteOptions {
  popToExistingHostRoute?: boolean;
}

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

function findStackKeyWithRouteName(state: unknown, routeName: string): string | null {
  if (!state || typeof state !== "object") {
    return null;
  }

  const candidate = state as {
    key?: unknown;
    routeNames?: unknown;
    routes?: unknown;
  };
  if (
    typeof candidate.key === "string" &&
    Array.isArray(candidate.routeNames) &&
    candidate.routeNames.includes(routeName)
  ) {
    return candidate.key;
  }

  if (!Array.isArray(candidate.routes)) {
    return null;
  }

  for (const route of candidate.routes) {
    if (!route || typeof route !== "object") {
      continue;
    }
    const childKey = findStackKeyWithRouteName((route as { state?: unknown }).state, routeName);
    if (childKey) {
      return childKey;
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
  const target = findStackKeyWithRouteName(rootState, ROOT_HOST_ROUTE_NAME);
  if (!target) {
    return false;
  }

  const action: NavigationAction = {
    type: "POP_TO",
    target,
    payload: {
      name: ROOT_HOST_ROUTE_NAME,
      params: {
        serverId: selection.serverId,
        screen: HOST_WORKSPACE_ROUTE_NAME,
        params: {
          serverId: selection.serverId,
          workspaceId: encodeWorkspaceIdForPathSegment(selection.workspaceId),
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
  options: NavigateToHostWorkspaceRouteOptions = {},
): void {
  if (options.popToExistingHostRoute && dispatchHostWorkspacePopTo(route)) {
    return;
  }

  router.dismissTo(route as Href);
}
