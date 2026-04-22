import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/constants/platform", () => ({
  isWeb: true,
}));

function installWindowStub(pathname: string) {
  const windowStub = {
    location: {
      href: "",
      origin: "http://localhost",
      pathname: "",
      search: "",
      hash: "",
    },
    history: {
      pushState: vi.fn((_state: unknown, _title: string, url: string) => {
        updateLocation(url);
      }),
      replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
        updateLocation(url);
      }),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  function updateLocation(url: string) {
    const next = new URL(url, windowStub.location.origin);
    windowStub.location = {
      href: next.href,
      origin: next.origin,
      pathname: next.pathname,
      search: next.search,
      hash: next.hash,
    };
  }

  updateLocation(pathname);
  vi.stubGlobal("window", windowStub);
  return windowStub;
}

function createNavigationRef(serverId: string, workspaceId: string) {
  return {
    current: {
      getCurrentRoute: () => ({
        params: { serverId, workspaceId },
      }),
    },
  };
}

function createNavigationPathRef(path: string) {
  return {
    current: {
      getCurrentRoute: () => ({
        path,
      }),
    },
  };
}

function createNavigationPathWithParamsRef(path: string, serverId: string, workspaceId: string) {
  return {
    current: {
      getCurrentRoute: () => ({
        path,
        params: { serverId, workspaceId },
      }),
    },
  };
}

describe("navigation active workspace store", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps explicit web workspace activation ahead of a stale navigation route sync", async () => {
    installWindowStub("/h/server-1/workspace/workspace-a");
    const store = await import("@/stores/navigation-active-workspace-store");

    store.syncNavigationActiveWorkspace(createNavigationRef("server-1", "workspace-a"));
    expect(store.getNavigationActiveWorkspaceSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
    });

    store.activateNavigationWorkspaceSelection(
      { serverId: "server-1", workspaceId: "workspace-b" },
      { updateBrowserHistory: true, historyMode: "push" },
    );
    store.syncNavigationActiveWorkspace(createNavigationRef("server-1", "workspace-a"));

    expect(store.getNavigationActiveWorkspaceSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-b",
    });
  });

  it("clears a stale browser workspace when navigation sync reports a non-workspace route", async () => {
    installWindowStub("/h/server-1/workspace/workspace-a");
    const store = await import("@/stores/navigation-active-workspace-store");

    store.syncNavigationActiveWorkspace(createNavigationRef("server-1", "workspace-a"));
    expect(store.getNavigationActiveWorkspaceSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
    });
    expect(store.getLastNavigationWorkspaceRouteSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
    });

    store.syncNavigationActiveWorkspace(createNavigationPathRef("/h/server-1/sessions"));

    expect(store.getNavigationActiveWorkspaceSelection()).toBeNull();
    expect(store.getLastNavigationWorkspaceRouteSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
    });
  });

  it("clears stale workspace params when navigation sync reports a non-workspace path", async () => {
    installWindowStub("/h/server-1/workspace/workspace-a");
    const store = await import("@/stores/navigation-active-workspace-store");

    store.syncNavigationActiveWorkspace(createNavigationRef("server-1", "workspace-a"));
    expect(store.getNavigationActiveWorkspaceSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
    });

    store.syncNavigationActiveWorkspace(
      createNavigationPathWithParamsRef("/h/server-1/sessions", "server-1", "workspace-a"),
    );

    expect(store.getNavigationActiveWorkspaceSelection()).toBeNull();
  });

  it("uses a one-shot workspace route override when returning to a retained shell", async () => {
    installWindowStub("/h/server-1/workspace/workspace-a");
    const store = await import("@/stores/navigation-active-workspace-store");

    store.syncNavigationActiveWorkspace(
      createNavigationPathRef("/h/server-1/workspace/workspace-a"),
    );
    store.overrideNextNavigationWorkspaceRouteSelection({
      serverId: "server-1",
      workspaceId: "workspace-b",
    });

    store.syncNavigationActiveWorkspace(
      createNavigationPathRef("/h/server-1/workspace/workspace-a"),
    );

    expect(store.getNavigationActiveWorkspaceSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-b",
    });

    store.syncNavigationActiveWorkspace(
      createNavigationPathRef("/h/server-1/workspace/workspace-a"),
    );

    expect(store.getNavigationActiveWorkspaceSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
    });
  });
});
