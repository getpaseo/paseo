import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@server/client/daemon-client";
import { queryClient as appQueryClient } from "@/query/query-client";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  __resetCheckoutGitActionsStoreForTests,
  invalidateCheckoutGitQueriesForClient,
  isLocalWorktreeArchivePending,
  useCheckoutGitActionsStore,
} from "@/stores/checkout-git-actions-store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function workspace(input: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id">) {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    projectDisplayName: input.projectDisplayName ?? "Project",
    projectRootPath: input.projectRootPath ?? "/tmp/repo",
    workspaceDirectory: input.workspaceDirectory ?? input.id,
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "worktree",
    name: input.name ?? input.id,
    status: input.status ?? "done",
    archivingAt: input.archivingAt ?? null,
    diffStat: input.diffStat ?? null,
    scripts: input.scripts ?? [],
  } satisfies WorkspaceDescriptor;
}

describe("checkout-git-actions-store", () => {
  const serverId = "server-1";
  const cwd = "/tmp/repo";

  beforeEach(() => {
    vi.useFakeTimers();
    __resetCheckoutGitActionsStoreForTests();
    appQueryClient.clear();
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetCheckoutGitActionsStoreForTests();
    appQueryClient.clear();
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
  });

  it("shares pending state per checkout and de-dupes in-flight calls", async () => {
    const deferred = createDeferred<unknown>();
    const client = {
      checkoutCommit: vi.fn(() => deferred.promise),
    };

    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
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

  it("runs pull then push sequentially for pull-and-push", async () => {
    const order: string[] = [];
    const client = {
      checkoutPull: vi.fn(async () => {
        order.push("pull");
        return {};
      }),
      checkoutPush: vi.fn(async () => {
        order.push("push");
        return {};
      }),
    };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await useCheckoutGitActionsStore.getState().pullAndPush({ serverId, cwd });

    expect(order).toEqual(["pull", "push"]);
    expect(client.checkoutPull).toHaveBeenCalledWith(cwd);
    expect(client.checkoutPush).toHaveBeenCalledWith(cwd);
  });

  it("does not push when pull fails for pull-and-push", async () => {
    const client = {
      checkoutPull: vi.fn(async () => ({ error: { message: "pull conflict" } })),
      checkoutPush: vi.fn(async () => ({})),
    };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await expect(
      useCheckoutGitActionsStore.getState().pullAndPush({ serverId, cwd }),
    ).rejects.toThrow("pull conflict");
    expect(client.checkoutPush).not.toHaveBeenCalled();
  });

  it("surfaces push errors from pull-and-push after a successful pull", async () => {
    const client = {
      checkoutPull: vi.fn(async () => ({})),
      checkoutPush: vi.fn(async () => ({ error: { message: "push rejected" } })),
    };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await expect(
      useCheckoutGitActionsStore.getState().pullAndPush({ serverId, cwd }),
    ).rejects.toThrow("push rejected");
    expect(client.checkoutPull).toHaveBeenCalledTimes(1);
    expect(client.checkoutPush).toHaveBeenCalledTimes(1);
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

  it("hides an archived worktree optimistically while the archive RPC is in flight", async () => {
    const deferred = createDeferred<Record<string, never>>();
    const client = {
      archivePaseoWorktree: vi.fn(() => deferred.promise),
    };
    const featureWorkspace = workspace({ id: cwd, name: "feature" });
    useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient);
    useSessionStore.getState().setWorkspaces(serverId, new Map([[cwd, featureWorkspace]]));
    appQueryClient.setQueryData(
      ["sidebarPaseoWorktreeList", serverId, "/tmp"],
      [{ worktreePath: cwd }, { worktreePath: "/tmp/other" }],
    );

    const archive = useCheckoutGitActionsStore
      .getState()
      .archiveWorktree({ serverId, cwd, worktreePath: cwd });

    expect(client.archivePaseoWorktree).toHaveBeenCalledWith({ worktreePath: cwd });
    expect(useSessionStore.getState().sessions[serverId]?.workspaces.has(cwd)).toBe(false);
    expect(appQueryClient.getQueryData(["sidebarPaseoWorktreeList", serverId, "/tmp"])).toEqual([
      { worktreePath: "/tmp/other" },
    ]);
    expect(isLocalWorktreeArchivePending({ serverId, cwd })).toBe(true);

    deferred.resolve({});
    await archive;
  });

  it("restores an optimistically hidden worktree when archive fails", async () => {
    const client = {
      archivePaseoWorktree: vi.fn(async () => ({ error: { message: "archive failed" } })),
    };
    const featureWorkspace = workspace({ id: cwd, name: "feature" });
    const listSnapshot = [{ worktreePath: cwd }, { worktreePath: "/tmp/other" }];
    useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient);
    useSessionStore.getState().setWorkspaces(serverId, new Map([[cwd, featureWorkspace]]));
    appQueryClient.setQueryData(["sidebarPaseoWorktreeList", serverId, "/tmp"], listSnapshot);

    await expect(
      useCheckoutGitActionsStore.getState().archiveWorktree({ serverId, cwd, worktreePath: cwd }),
    ).rejects.toThrow("archive failed");

    expect(useSessionStore.getState().sessions[serverId]?.workspaces.get(cwd)).toEqual(
      featureWorkspace,
    );
    expect(appQueryClient.getQueryData(["sidebarPaseoWorktreeList", serverId, "/tmp"])).toEqual(
      listSnapshot,
    );
  });

  it("reports local archive pending only while the archive action is in flight", async () => {
    const deferred = createDeferred<Record<string, never>>();
    const client = {
      archivePaseoWorktree: vi.fn(() => deferred.promise),
    };
    const featureWorkspace = workspace({ id: cwd, name: "feature" });
    useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient);
    useSessionStore.getState().setWorkspaces(serverId, new Map([[cwd, featureWorkspace]]));

    const archive = useCheckoutGitActionsStore
      .getState()
      .archiveWorktree({ serverId, cwd, worktreePath: cwd });

    expect(isLocalWorktreeArchivePending({ serverId, cwd })).toBe(true);

    deferred.resolve({});
    await archive;

    expect(isLocalWorktreeArchivePending({ serverId, cwd })).toBe(false);
  });
});
