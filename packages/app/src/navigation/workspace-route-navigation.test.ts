import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationContainerRefWithCurrent } from "@react-navigation/native";
import {
  navigateToHostWorkspaceRoute,
  registerWorkspaceRouteNavigationRef,
} from "./workspace-route-navigation";

function createNavigationRef(rootState: unknown, options: { ready?: boolean } = {}) {
  const dispatch = vi.fn();
  const navigationRef = {
    current: {
      isReady: () => options.ready ?? true,
      getRootState: () => rootState,
      dispatch,
    },
  } as unknown as NavigationContainerRefWithCurrent<ReactNavigation.RootParamList>;

  return { navigationRef, dispatch };
}

describe("navigateToHostWorkspaceRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerWorkspaceRouteNavigationRef({
      current: null,
    } as unknown as NavigationContainerRefWithCurrent<ReactNavigation.RootParamList>)();
  });

  it("falls back to route navigation when no host route is mounted yet", () => {
    const { navigationRef, dispatch } = createNavigationRef({
      key: "root-stack",
      routeNames: ["index", "settings/[section]", "h/[serverId]"],
      routes: [{ key: "settings-general", name: "settings/[section]" }],
    });
    registerWorkspaceRouteNavigationRef(navigationRef);
    const dismissTo = vi.fn();

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", { dismissTo });

    expect(dispatch).not.toHaveBeenCalled();
    expect(dismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-a");
  });

  it("pops to the mounted host route and targets the requested workspace", () => {
    const { navigationRef, dispatch } = createNavigationRef({
      key: "root-stack",
      routeNames: ["index", "settings/[section]", "h/[serverId]"],
      routes: [
        {
          key: "host-server-1",
          name: "h/[serverId]",
          params: { serverId: "server-1" },
        },
        { key: "settings-general", name: "settings/[section]" },
      ],
    });
    registerWorkspaceRouteNavigationRef(navigationRef);
    const dismissTo = vi.fn();

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", { dismissTo });

    expect(dismissTo).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "POP_TO",
      target: "root-stack",
      payload: {
        name: "h/[serverId]",
        params: {
          serverId: "server-1",
          screen: "workspace/[workspaceId]/index",
          params: {
            serverId: "server-1",
            workspaceId: "workspace-a",
          },
          pop: true,
        },
      },
    });
  });
});
