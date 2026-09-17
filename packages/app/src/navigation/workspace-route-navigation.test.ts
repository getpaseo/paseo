import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationContainerRefWithCurrent } from "@react-navigation/native";
import {
  navigateToHostWorkspaceRoute,
  registerWorkspaceRouteNavigationRef,
} from "./workspace-route-navigation";

function createNavigationRef(rootState: unknown, options: { ready?: boolean } = {}) {
  const dispatch = vi.fn();
  let ready = options.ready ?? true;
  const readyListeners = new Set<() => void>();
  const navigation = {
    isReady: () => ready,
    getRootState: () => rootState,
    dispatch,
    addListener: (event: string, listener: () => void) => {
      if (event === "ready") readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
  };
  const navigationRef = {
    ...navigation,
    current: navigation,
  } as unknown as NavigationContainerRefWithCurrent<ReactNavigation.RootParamList>;

  return {
    navigationRef,
    dispatch,
    becomeReady() {
      ready = true;
      for (const listener of readyListeners) listener();
    },
  };
}

describe("navigateToHostWorkspaceRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerWorkspaceRouteNavigationRef(createNavigationRef({}).navigationRef)();
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
      index: 1,
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

  it("uses route navigation when the mounted host route is already focused", () => {
    const { navigationRef, dispatch } = createNavigationRef({
      key: "root-stack",
      index: 0,
      routes: [
        {
          key: "host-server-1",
          name: "h/[serverId]",
          params: { serverId: "server-1" },
        },
      ],
    });
    registerWorkspaceRouteNavigationRef(navigationRef);
    const dismissTo = vi.fn();

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-b", { dismissTo });

    expect(dispatch).not.toHaveBeenCalled();
    expect(dismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-b");
  });

  it("preserves a workspace open intent in the POP_TO target", () => {
    const { navigationRef, dispatch } = createNavigationRef({
      key: "root-stack",
      index: 1,
      routes: [
        { key: "host-server-1", name: "h/[serverId]" },
        { key: "new", name: "new" },
      ],
    });
    registerWorkspaceRouteNavigationRef(navigationRef);

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a?open=agent%3Aagent-1");

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
            open: "agent:agent-1",
          },
          pop: true,
        },
      },
    });
  });

  it("waits for the root navigator before applying a route intent", () => {
    const { navigationRef, becomeReady } = createNavigationRef(
      {
        key: "root-stack",
        routes: [{ key: "launcher", name: "index" }],
      },
      { ready: false },
    );
    registerWorkspaceRouteNavigationRef(navigationRef);
    const dismissTo = vi.fn();

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", { dismissTo });
    expect(dismissTo).not.toHaveBeenCalled();

    becomeReady();
    expect(dismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-a");
    becomeReady();
    expect(dismissTo).toHaveBeenCalledTimes(1);
  });

  it("retains an intent submitted before the root ref registers", () => {
    const dismissTo = vi.fn();
    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", { dismissTo });
    expect(dismissTo).not.toHaveBeenCalled();

    const root = createNavigationRef({}, { ready: false });
    const unregister = registerWorkspaceRouteNavigationRef(root.navigationRef);
    expect(dismissTo).not.toHaveBeenCalled();
    root.becomeReady();
    expect(dismissTo).toHaveBeenCalledExactlyOnceWith("/h/server-1/workspace/workspace-a");
    unregister();
  });

  it("keeps only the latest route intent while the root navigator is unavailable", () => {
    const { navigationRef, becomeReady } = createNavigationRef({}, { ready: false });
    registerWorkspaceRouteNavigationRef(navigationRef);
    const firstDismissTo = vi.fn();
    const latestDismissTo = vi.fn();

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", {
      dismissTo: firstDismissTo,
    });
    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-b", {
      dismissTo: latestDismissTo,
    });
    becomeReady();

    expect(firstDismissTo).not.toHaveBeenCalled();
    expect(latestDismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-b");
  });

  it("preserves a pending route intent across root navigator re-registration", () => {
    const first = createNavigationRef({}, { ready: false });
    const unregisterFirst = registerWorkspaceRouteNavigationRef(first.navigationRef);
    const dismissTo = vi.fn();
    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", { dismissTo });

    unregisterFirst();
    first.becomeReady();
    expect(dismissTo).not.toHaveBeenCalled();

    const replacement = createNavigationRef({
      key: "root-stack",
      routes: [{ key: "launcher", name: "index" }],
    });
    registerWorkspaceRouteNavigationRef(replacement.navigationRef);

    expect(dismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-a");
  });
});
