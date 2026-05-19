import { describe, expect, it, vi } from "vitest";

const routerMock = vi.hoisted(() => ({
  dismissTo: vi.fn(),
}));

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(async () => undefined),
}));

vi.mock("expo-router", () => ({
  router: routerMock,
  useLocalSearchParams: () => ({}),
  usePathname: () => "/",
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMock,
}));

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("workspace navigation hydration", () => {
  it("keeps a newer workspace selection when storage hydration finishes late", async () => {
    vi.resetModules();
    routerMock.dismissTo.mockReset();
    asyncStorageMock.getItem.mockReset();
    asyncStorageMock.setItem.mockClear();
    const storedSelection = deferred<string | null>();
    asyncStorageMock.getItem.mockImplementation(() => storedSelection.promise);
    const store = await import("@/stores/navigation-active-workspace-store");

    store.navigateToWorkspace("server-new", "workspace-new");
    storedSelection.resolve(
      JSON.stringify({ serverId: "server-old", workspaceId: "workspace-old" }),
    );
    await store.hydrateLastWorkspaceSelection();

    expect(store.getLastWorkspaceSelection()).toEqual({
      serverId: "server-new",
      workspaceId: "workspace-new",
    });
  });
});
