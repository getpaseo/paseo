import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const asyncStorageMock = vi.hoisted(() => {
  const storage = new Map<string, string>();
  return {
    storage,
    getItem: vi.fn(async (key: string): Promise<string | null> => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string): Promise<void> => {
      storage.set(key, value);
    }),
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMock,
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
}));

const LAST_WORKSPACE_ROUTE_SELECTION_STORAGE_KEY = "paseo:last-workspace-route-selection";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

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
    asyncStorageMock.storage.clear();
    asyncStorageMock.getItem.mockReset();
    asyncStorageMock.setItem.mockReset();
    asyncStorageMock.getItem.mockImplementation(
      async (key: string): Promise<string | null> => asyncStorageMock.storage.get(key) ?? null,
    );
    asyncStorageMock.setItem.mockImplementation(
      async (key: string, value: string): Promise<void> => {
        asyncStorageMock.storage.set(key, value);
      },
    );
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

  it("hydrates the last workspace route selection from storage on startup", async () => {
    const storedSelection = createDeferred<string | null>();
    asyncStorageMock.getItem.mockReturnValue(storedSelection.promise);
    installWindowStub("/open-project");

    const store = await import("@/stores/navigation-active-workspace-store");

    expect(store.getIsLastNavigationWorkspaceRouteSelectionLoaded()).toBe(false);
    const hydration = store.hydrateLastNavigationWorkspaceRouteSelection();
    storedSelection.resolve(JSON.stringify({ serverId: "server-1", workspaceId: "workspace-a" }));
    await hydration;

    expect(asyncStorageMock.getItem).toHaveBeenCalledWith(
      LAST_WORKSPACE_ROUTE_SELECTION_STORAGE_KEY,
    );
    expect(store.getLastNavigationWorkspaceRouteSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
    });
    expect(store.getIsLastNavigationWorkspaceRouteSelectionLoaded()).toBe(true);
  });

  it("hydrates empty and corrupt workspace route storage as null", async () => {
    installWindowStub("/open-project");

    let store = await import("@/stores/navigation-active-workspace-store");
    await store.hydrateLastNavigationWorkspaceRouteSelection();

    expect(store.getLastNavigationWorkspaceRouteSelection()).toBeNull();
    expect(store.getIsLastNavigationWorkspaceRouteSelectionLoaded()).toBe(true);

    vi.resetModules();
    asyncStorageMock.getItem.mockResolvedValueOnce("{not json");
    store = await import("@/stores/navigation-active-workspace-store");
    await store.hydrateLastNavigationWorkspaceRouteSelection();

    expect(store.getLastNavigationWorkspaceRouteSelection()).toBeNull();
    expect(store.getIsLastNavigationWorkspaceRouteSelectionLoaded()).toBe(true);
  });

  it("persists valid last workspace route selections", async () => {
    installWindowStub("/h/server-1/workspace/workspace-a");
    const store = await import("@/stores/navigation-active-workspace-store");
    await store.hydrateLastNavigationWorkspaceRouteSelection();

    store.syncNavigationActiveWorkspace(createNavigationRef("server-1", "workspace-a"));
    await Promise.resolve(); // flush the fire-and-forget setItem microtask

    vi.resetModules();
    const freshStore = await import("@/stores/navigation-active-workspace-store");
    await freshStore.hydrateLastNavigationWorkspaceRouteSelection();

    expect(freshStore.getLastNavigationWorkspaceRouteSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
    });
    expect(freshStore.getIsLastNavigationWorkspaceRouteSelectionLoaded()).toBe(true);
  });
});
