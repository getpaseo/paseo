import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { queryClient as appQueryClient } from "@/data/query-client";
import { useSessionStore } from "@/stores/session-store";
import {
  __resetCheckoutGitActionsStoreForTests,
  useCheckoutGitActionsStore,
} from "@/git/actions-store";
import { checkoutDiffQueryKey } from "@/git/query-keys";

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

function registerMockClient(
  targetServerId: string,
  client: Partial<Record<keyof DaemonClient, unknown>>,
) {
  useSessionStore.getState().initializeSession(targetServerId, client as unknown as DaemonClient);
}

describe("checkout-git-actions-store", () => {
  const serverId = "server-1";
  const cwd = "/tmp/repo/worktrees/feature";

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

    registerMockClient(serverId, client);

    const store = useCheckoutGitActionsStore.getState();

    const first = store.commit({ serverId, cwd });
    const second = store.commit({ serverId, cwd });

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
    registerMockClient(serverId, client);

    await useCheckoutGitActionsStore.getState().pullAndPush({ serverId, cwd });

    expect(order).toEqual(["pull", "push"]);
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "pull-and-push" }),
    ).toBe("success");
  });

  it("does not push when pull fails for pull-and-push", async () => {
    const client = {
      checkoutPull: vi.fn(async () => ({ error: { message: "pull conflict" } })),
      checkoutPush: vi.fn(async () => ({})),
    };
    registerMockClient(serverId, client);

    await expect(
      useCheckoutGitActionsStore.getState().pullAndPush({ serverId, cwd }),
    ).rejects.toThrow("pull conflict");
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "pull-and-push" }),
    ).toBe("idle");
  });

  it("surfaces push errors from pull-and-push after a successful pull", async () => {
    const client = {
      checkoutPull: vi.fn(async () => ({})),
      checkoutPush: vi.fn(async () => ({ error: { message: "push rejected" } })),
    };
    registerMockClient(serverId, client);

    await expect(
      useCheckoutGitActionsStore.getState().pullAndPush({ serverId, cwd }),
    ).rejects.toThrow("push rejected");
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "pull-and-push" }),
    ).toBe("idle");
  });

  it("refreshes git and GitHub state and reports success", async () => {
    const client = {
      checkoutRefresh: vi.fn(async () => ({ success: true, error: null })),
    };
    registerMockClient(serverId, client);

    await useCheckoutGitActionsStore.getState().refresh({ serverId, cwd });

    expect(client.checkoutRefresh).toHaveBeenCalledWith(cwd);
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "refresh" }),
    ).toBe("success");
  });

  it("surfaces a refresh error and returns to idle", async () => {
    const client = {
      checkoutRefresh: vi.fn(async () => ({ error: { message: "not a git repository" } })),
    };
    registerMockClient(serverId, client);

    await expect(useCheckoutGitActionsStore.getState().refresh({ serverId, cwd })).rejects.toThrow(
      "not a git repository",
    );
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "refresh" }),
    ).toBe("idle");
  });

  it("discards selected paths through the shared checkout action workflow", async () => {
    const checkoutDiscardChanges = vi.fn(async () => ({ success: true, error: null }));
    const client = { checkoutDiscardChanges };
    registerMockClient(serverId, client);

    await useCheckoutGitActionsStore
      .getState()
      .discardChanges({ serverId, cwd, paths: ["renamed.ts", "original.ts"] });

    expect(checkoutDiscardChanges).toHaveBeenCalledWith(cwd, {
      paths: ["renamed.ts", "original.ts"],
    });
    expect(
      useCheckoutGitActionsStore
        .getState()
        .getStatus({ serverId, cwd, actionId: "discard-changes" }),
    ).toBe("success");
  });

  it("optimistically moves files and queues rapid unstage operations without dropping paths", async () => {
    const stagedKey = checkoutDiffQueryKey(serverId, cwd, "staged");
    const unstagedKey = checkoutDiffQueryKey(serverId, cwd, "unstaged");
    const file = (path: string) =>
      ({
        path,
        isNew: false,
        isDeleted: false,
        additions: 1,
        deletions: 0,
        hunks: [],
      }) as ParsedDiffFile;
    appQueryClient.setQueryData(stagedKey, {
      cwd,
      files: [file("docs/guide.md"), file("README.md")],
      error: null,
    });
    appQueryClient.setQueryData(unstagedKey, { cwd, files: [], error: null });

    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const checkoutIndexUpdate = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { checkoutIndexUpdate };
    registerMockClient(serverId, client);

    const store = useCheckoutGitActionsStore.getState();
    const firstUnstage = store.unstage({ serverId, cwd, paths: ["docs/guide.md"] });
    const secondUnstage = store.unstage({ serverId, cwd, paths: ["README.md"] });

    expect(appQueryClient.getQueryData(stagedKey)).toMatchObject({ files: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(checkoutIndexUpdate).toHaveBeenCalledTimes(1);

    first.resolve({ success: true, error: null });
    await firstUnstage;
    await Promise.resolve();
    expect(checkoutIndexUpdate).toHaveBeenCalledTimes(2);
    expect(checkoutIndexUpdate).toHaveBeenLastCalledWith(cwd, {
      operation: "unstage",
      paths: ["README.md"],
    });

    second.resolve({ success: true, error: null });
    await secondUnstage;
    expect(appQueryClient.getQueryData(unstagedKey)).toMatchObject({
      files: [
        expect.objectContaining({ path: "docs/guide.md" }),
        expect.objectContaining({ path: "README.md" }),
      ],
    });
  });

  it("rolls back an optimistic index move when Git rejects the operation", async () => {
    const stagedKey = checkoutDiffQueryKey(serverId, cwd, "staged");
    const unstagedKey = checkoutDiffQueryKey(serverId, cwd, "unstaged");
    const markdownFile = {
      path: "docs/guide.md",
      isNew: false,
      isDeleted: false,
      additions: 1,
      deletions: 0,
      hunks: [],
    } as ParsedDiffFile;
    appQueryClient.setQueryData(stagedKey, { cwd, files: [markdownFile], error: null });
    appQueryClient.setQueryData(unstagedKey, { cwd, files: [], error: null });
    const client = {
      checkoutIndexUpdate: vi.fn(async () => ({
        success: false,
        error: { message: "index locked" },
      })),
    };
    registerMockClient(serverId, client);

    const operation = useCheckoutGitActionsStore
      .getState()
      .unstage({ serverId, cwd, paths: [markdownFile.path] });
    expect(appQueryClient.getQueryData(stagedKey)).toMatchObject({ files: [] });

    await expect(operation).rejects.toThrow("index locked");
    expect(appQueryClient.getQueryData(stagedKey)).toMatchObject({
      files: [expect.objectContaining({ path: markdownFile.path })],
    });
    expect(appQueryClient.getQueryData(unstagedKey)).toMatchObject({ files: [] });
  });

  it("preserves subsequent optimistic updates when an earlier concurrent index move rolls back", async () => {
    const stagedKey = checkoutDiffQueryKey(serverId, cwd, "staged");
    const unstagedKey = checkoutDiffQueryKey(serverId, cwd, "unstaged");
    const file = (path: string) =>
      ({
        path,
        isNew: false,
        isDeleted: false,
        additions: 1,
        deletions: 0,
        hunks: [],
      }) as ParsedDiffFile;

    appQueryClient.setQueryData(stagedKey, { cwd, files: [], error: null });
    appQueryClient.setQueryData(unstagedKey, {
      cwd,
      files: [file("docs/guide.md"), file("README.md")],
      error: null,
    });

    const first = createDeferred<{ success: boolean; error: { message: string } | null }>();
    const second = createDeferred<{ success: boolean; error: { message: string } | null }>();
    const checkoutIndexUpdate = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    registerMockClient(serverId, { checkoutIndexUpdate });

    const store = useCheckoutGitActionsStore.getState();
    const firstStage = store.stage({ serverId, cwd, paths: ["docs/guide.md"] });
    const secondStage = store.stage({ serverId, cwd, paths: ["README.md"] });

    // Both files are optimistically in staged
    expect(appQueryClient.getQueryData(stagedKey)).toMatchObject({
      files: [
        expect.objectContaining({ path: "docs/guide.md" }),
        expect.objectContaining({ path: "README.md" }),
      ],
    });
    expect(appQueryClient.getQueryData(unstagedKey)).toMatchObject({ files: [] });

    // The first operation fails on the server and rolls back
    first.resolve({ success: false, error: { message: "failed to stage guide.md" } });
    await expect(firstStage).rejects.toThrow("failed to stage guide.md");

    // guide.md rolled back to unstaged, but README.md remains optimistically staged
    expect(appQueryClient.getQueryData(stagedKey)).toMatchObject({
      files: [expect.objectContaining({ path: "README.md" })],
    });
    expect(appQueryClient.getQueryData(unstagedKey)).toMatchObject({
      files: [expect.objectContaining({ path: "docs/guide.md" })],
    });

    // The second operation succeeds on the server
    second.resolve({ success: true, error: null });
    await secondStage;

    expect(appQueryClient.getQueryData(stagedKey)).toMatchObject({
      files: [expect.objectContaining({ path: "README.md" })],
    });
  });

  for (const rpc of [
    {
      label: "forge",
      method: "checkoutForgeSetAutoMerge",
      feature: "checkoutForgeSetAutoMerge",
    },
    {
      label: "legacy GitHub",
      method: "checkoutGithubSetAutoMerge",
      feature: "checkoutGithubSetAutoMerge",
    },
  ] as const) {
    it(`enables PR auto-merge through the ${rpc.label} RPC`, async () => {
      const setAutoMerge = vi.fn(async () => ({
        enabled: true,
        success: true,
        error: null,
      }));
      const client = { [rpc.method]: setAutoMerge };
      registerMockClient(serverId, client);
      useSessionStore.getState().updateSessionServerInfo(serverId, {
        serverId,
        hostname: null,
        version: null,
        features: { [rpc.feature]: true },
      });

      await useCheckoutGitActionsStore
        .getState()
        .enablePrAutoMerge({ serverId, cwd, method: "squash" });

      expect(setAutoMerge).toHaveBeenCalledWith(cwd, {
        enabled: true,
        method: "squash",
      });
      expect(
        useCheckoutGitActionsStore
          .getState()
          .getStatus({ serverId, cwd, actionId: "enable-pr-auto-merge-squash" }),
      ).toBe("success");
    });

    it(`disables PR auto-merge through the ${rpc.label} RPC`, async () => {
      const setAutoMerge = vi.fn(async () => ({
        enabled: false,
        success: true,
        error: null,
      }));
      const client = { [rpc.method]: setAutoMerge };
      registerMockClient(serverId, client);
      useSessionStore.getState().updateSessionServerInfo(serverId, {
        serverId,
        hostname: null,
        version: null,
        features: { [rpc.feature]: true },
      });

      await useCheckoutGitActionsStore.getState().disablePrAutoMerge({ serverId, cwd });

      expect(setAutoMerge).toHaveBeenCalledWith(cwd, { enabled: false });
      expect(
        useCheckoutGitActionsStore
          .getState()
          .getStatus({ serverId, cwd, actionId: "disable-pr-auto-merge" }),
      ).toBe("success");
    });
  }

  it("does not call PR auto-merge RPCs when the daemon lacks the feature flag", async () => {
    const client = {
      checkoutForgeSetAutoMerge: vi.fn(async () => ({
        enabled: true,
        success: true,
        error: null,
      })),
    };
    registerMockClient(serverId, client);
    useSessionStore.getState().updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: null,
      features: {},
    });

    await expect(
      useCheckoutGitActionsStore.getState().enablePrAutoMerge({ serverId, cwd, method: "merge" }),
    ).rejects.toThrow("Update the host to use auto-merge actions.");

    expect(client.checkoutForgeSetAutoMerge).not.toHaveBeenCalled();
    expect(
      useCheckoutGitActionsStore
        .getState()
        .getStatus({ serverId, cwd, actionId: "enable-pr-auto-merge-merge" }),
    ).toBe("idle");
  });
});
