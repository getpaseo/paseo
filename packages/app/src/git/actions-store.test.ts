import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient as appQueryClient } from "@/data/query-client";
import { useSessionStore } from "@/stores/session-store";
import {
  __resetCheckoutGitActionsStoreForTests,
  useCheckoutGitActionsStore,
} from "@/git/actions-store";
import type { WorkspaceGitClient } from "@/git/workspace-git";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() },
}));

const serverId = "server-1";
function capability(methods: Record<string, unknown>): WorkspaceGitClient {
  return {
    workspaceId: "workspace-1",
    cwd: "/tmp/repo/worktrees/feature",
    ...methods,
  } as unknown as WorkspaceGitClient;
}

describe("checkout-git-actions-store", () => {
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
  });

  it("binds once to workspace identity and de-duplicates an in-flight commit", async () => {
    let resolve!: (value: { error: null }) => void;
    const commit = vi.fn(() => new Promise<{ error: null }>((done) => (resolve = done)));
    const target = capability({ commit });
    const store = useCheckoutGitActionsStore.getState();

    const first = store.commit({ serverId, target });
    const second = store.commit({ serverId, target });
    expect(store.getStatus({ serverId, target, actionId: "commit" })).toBe("pending");
    resolve({ error: null });
    await Promise.all([first, second]);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(store.getStatus({ serverId, target, actionId: "commit" })).toBe("success");
  });

  it("runs pull then push sequentially through the same bound capability", async () => {
    const order: string[] = [];
    const target = capability({
      pull: vi.fn(async () => {
        order.push("pull");
        return { error: null };
      }),
      push: vi.fn(async () => {
        order.push("push");
        return { error: null };
      }),
    });
    await useCheckoutGitActionsStore.getState().pullAndPush({ serverId, target });
    expect(order).toEqual(["pull", "push"]);
  });

  it("does not push when pull fails", async () => {
    const push = vi.fn();
    const target = capability({
      pull: vi.fn(async () => ({ error: { message: "pull conflict" } })),
      push,
    });

    await expect(
      useCheckoutGitActionsStore.getState().pullAndPush({ serverId, target }),
    ).rejects.toThrow("pull conflict");
    expect(push).not.toHaveBeenCalled();
    expect(
      useCheckoutGitActionsStore
        .getState()
        .getStatus({ serverId, target, actionId: "pull-and-push" }),
    ).toBe("idle");
  });

  it("returns to idle when a bound mutation reports an error", async () => {
    const target = capability({
      refresh: vi.fn(async () => ({ error: { message: "not git" } })),
    });
    await expect(
      useCheckoutGitActionsStore.getState().refresh({ serverId, target }),
    ).rejects.toThrow("not git");
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, target, actionId: "refresh" }),
    ).toBe("idle");
  });

  it("discards selected paths through the bound workspace capability", async () => {
    const discardChanges = vi.fn(async () => ({ success: true, error: null }));
    const target = capability({ discardChanges });

    await useCheckoutGitActionsStore
      .getState()
      .discardChanges({ serverId, target, paths: ["renamed.ts", "original.ts"] });

    expect(discardChanges).toHaveBeenCalledWith({ paths: ["renamed.ts", "original.ts"] });
    expect(
      useCheckoutGitActionsStore
        .getState()
        .getStatus({ serverId, target, actionId: "discard-changes" }),
    ).toBe("success");
  });

  it("fails auto-merge before invoking Git when the daemon lacks the feature", async () => {
    const setForgeAutoMerge = vi.fn();
    const target = capability({ setForgeAutoMerge });
    useSessionStore.getState().initializeSession(serverId, {} as never);
    useSessionStore.getState().updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: null,
      features: {},
    });
    await expect(
      useCheckoutGitActionsStore
        .getState()
        .enablePrAutoMerge({ serverId, target, method: "merge" }),
    ).rejects.toThrow("Update the host");
    expect(setForgeAutoMerge).not.toHaveBeenCalled();
  });
});
