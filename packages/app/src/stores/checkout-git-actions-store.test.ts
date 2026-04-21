import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/session-store";
import {
  __resetCheckoutGitActionsStoreForTests,
  invalidateCheckoutGitQueriesForClient,
  useCheckoutGitActionsStore,
} from "@/stores/checkout-git-actions-store";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("checkout-git-actions-store", () => {
  const serverId = "server-1";
  const cwd = "/tmp/repo";

  beforeEach(() => {
    vi.useFakeTimers();
    __resetCheckoutGitActionsStoreForTests();
    useSessionStore.setState((state) => ({ ...state, sessions: {} as any }));
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetCheckoutGitActionsStoreForTests();
    useSessionStore.setState((state) => ({ ...state, sessions: {} as any }));
  });

  it("shares pending state per checkout and de-dupes in-flight calls", async () => {
    const deferred = createDeferred<any>();
    const client = {
      checkoutCommit: vi.fn(() => deferred.promise),
    };

    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...(state.sessions as any),
        [serverId]: { client } as any,
      },
    }));

    const store = useCheckoutGitActionsStore.getState();

    const first = store.commit({ serverId, cwd });
    const second = store.commit({ serverId, cwd });

    expect(client.checkoutCommit).toHaveBeenCalledTimes(1);
    expect(store.getStatus({ serverId, cwd, actionId: "commit" })).toBe("pending");

    deferred.resolve({});
    await Promise.all([first, second]);

    expect(store.getStatus({ serverId, cwd, actionId: "commit" })).toBe("success");

    vi.advanceTimersByTime(1000);
    expect(store.getStatus({ serverId, cwd, actionId: "commit" })).toBe("idle");
  });

  it("invalidates checkout PR status and every PR pane timeline for a checkout", async () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(["checkoutPrStatus", serverId, cwd], { status: { number: 12 } });
    queryClient.setQueryData(["prPaneTimeline", serverId, cwd, 12], { items: [] });
    queryClient.setQueryData(["prPaneTimeline", serverId, cwd, 13], { items: [] });
    queryClient.setQueryData(["prPaneTimeline", serverId, "/tmp/other", 12], { items: [] });

    await invalidateCheckoutGitQueriesForClient(queryClient, { serverId, cwd });

    expect(queryClient.getQueryState(["checkoutPrStatus", serverId, cwd])?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(["prPaneTimeline", serverId, cwd, 12])?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(["prPaneTimeline", serverId, cwd, 13])?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(["prPaneTimeline", serverId, "/tmp/other", 12])?.isInvalidated,
    ).toBe(false);

    queryClient.clear();
  });
});
