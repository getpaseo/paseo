import type { CheckoutPrMergeMethod } from "@getpaseo/protocol/messages";
import { create } from "zustand";
import { queryClient as appQueryClient } from "@/data/query-client";
import { useSessionStore } from "@/stores/session-store";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import type { WorkspaceGitClient } from "@/git/workspace-git";

type WorkspaceGitTarget = WorkspaceGitClient;

const SUCCESS_DISPLAY_MS = 1000;

export type CheckoutGitActionStatus = "idle" | "pending" | "success";

export type CheckoutGitAsyncActionId =
  | "commit"
  | "pull"
  | "push"
  | "pull-and-push"
  | "refresh"
  | "create-pr"
  | "merge-pr-squash"
  | "merge-pr-merge"
  | "merge-pr-rebase"
  | "enable-pr-auto-merge-squash"
  | "enable-pr-auto-merge-merge"
  | "enable-pr-auto-merge-rebase"
  | "disable-pr-auto-merge"
  | "merge-branch"
  | "merge-from-base"
  | "discard-changes";

type CheckoutKey = string;
type StatusMap = Partial<Record<CheckoutGitAsyncActionId, CheckoutGitActionStatus>>;

function checkoutKey(serverId: string, target: WorkspaceGitTarget): CheckoutKey {
  return `${serverId}::${target.workspaceId}::${target.cwd}`;
}

type AutoMergeActionsRpc = "forge" | "github";

function resolveAutoMergeActionsRpc(serverId: string): AutoMergeActionsRpc {
  const session = useSessionStore.getState().sessions[serverId];
  if (session?.serverInfo?.features?.checkoutForgeSetAutoMerge === true) {
    return "forge";
  }
  // COMPAT(githubAutoMergeRpc): added in v0.1.106, remove after 2026-12-28 once
  // all supported clients use checkout.forge.set_auto_merge.*.
  if (session?.serverInfo?.features?.checkoutGithubSetAutoMerge === true) {
    return "github";
  }
  throw new Error("Update the host to use auto-merge actions.");
}

function setStatus(
  key: CheckoutKey,
  actionId: CheckoutGitAsyncActionId,
  status: CheckoutGitActionStatus,
) {
  useCheckoutGitActionsStore.setState((state) => {
    const current = state.statusByCheckout[key]?.[actionId] ?? "idle";
    if (current === status) {
      return state;
    }
    return {
      ...state,
      statusByCheckout: {
        ...state.statusByCheckout,
        [key]: {
          ...state.statusByCheckout[key],
          [actionId]: status,
        },
      },
    };
  });
}

function invalidateCheckoutGitQueries(serverId: string, target: WorkspaceGitTarget) {
  return invalidateCheckoutGitQueriesForClient(appQueryClient, { serverId, target });
}

const successTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Map<string, Promise<unknown>>();

function inFlightKey(key: CheckoutKey, actionId: CheckoutGitAsyncActionId): string {
  return `${key}::${actionId}`;
}

interface CheckoutGitActionsStoreState {
  statusByCheckout: Record<CheckoutKey, StatusMap>;

  getStatus: (params: {
    serverId: string;
    target: WorkspaceGitTarget;
    actionId: CheckoutGitAsyncActionId;
  }) => CheckoutGitActionStatus;

  commit: (params: { serverId: string; target: WorkspaceGitTarget }) => Promise<void>;
  pull: (params: { serverId: string; target: WorkspaceGitTarget }) => Promise<void>;
  push: (params: { serverId: string; target: WorkspaceGitTarget }) => Promise<void>;
  pullAndPush: (params: { serverId: string; target: WorkspaceGitTarget }) => Promise<void>;
  refresh: (params: { serverId: string; target: WorkspaceGitTarget }) => Promise<void>;
  createPr: (params: { serverId: string; target: WorkspaceGitTarget }) => Promise<void>;
  mergePr: (params: {
    serverId: string;
    target: WorkspaceGitTarget;
    method: CheckoutPrMergeMethod;
  }) => Promise<void>;
  enablePrAutoMerge: (params: {
    serverId: string;
    target: WorkspaceGitTarget;
    method: CheckoutPrMergeMethod;
  }) => Promise<void>;
  disablePrAutoMerge: (params: { serverId: string; target: WorkspaceGitTarget }) => Promise<void>;
  mergeBranch: (params: {
    serverId: string;
    target: WorkspaceGitTarget;
    baseRef: string;
  }) => Promise<void>;
  mergeFromBase: (params: {
    serverId: string;
    target: WorkspaceGitTarget;
    baseRef: string;
  }) => Promise<void>;
  discardChanges: (params: {
    serverId: string;
    target: WorkspaceGitTarget;
    paths: string[];
  }) => Promise<void>;
}

async function runCheckoutAction({
  serverId,
  target,
  actionId,
  run,
}: {
  serverId: string;
  target: WorkspaceGitTarget;
  actionId: CheckoutGitAsyncActionId;
  run: () => Promise<void>;
}): Promise<void> {
  const key = checkoutKey(serverId, target);
  const inflightId = inFlightKey(key, actionId);

  const existing = inFlight.get(inflightId);
  if (existing) {
    await existing;
    return;
  }

  const prevTimer = successTimers.get(inflightId);
  if (prevTimer) {
    clearTimeout(prevTimer);
    successTimers.delete(inflightId);
  }

  setStatus(key, actionId, "pending");

  const promise = (async () => {
    try {
      await run();
      await invalidateCheckoutGitQueries(serverId, target);
      setStatus(key, actionId, "success");
      const timer = setTimeout(() => {
        setStatus(key, actionId, "idle");
        successTimers.delete(inflightId);
      }, SUCCESS_DISPLAY_MS);
      successTimers.set(inflightId, timer);
    } catch (error) {
      setStatus(key, actionId, "idle");
      throw error;
    } finally {
      inFlight.delete(inflightId);
    }
  })();

  inFlight.set(inflightId, promise);
  await promise;
}

export const useCheckoutGitActionsStore = create<CheckoutGitActionsStoreState>()((set, get) => ({
  statusByCheckout: {},

  getStatus: ({ serverId, target, actionId }) => {
    const key = checkoutKey(serverId, target);
    return get().statusByCheckout[key]?.[actionId] ?? "idle";
  },

  commit: async ({ serverId, target }) => {
    await runCheckoutAction({
      serverId,
      target,
      actionId: "commit",
      run: async () => {
        const payload = await target.commit({ addAll: true });
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  pull: async ({ serverId, target }) => {
    await runCheckoutAction({
      serverId,
      target,
      actionId: "pull",
      run: async () => {
        const payload = await target.pull();
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  push: async ({ serverId, target }) => {
    await runCheckoutAction({
      serverId,
      target,
      actionId: "push",
      run: async () => {
        const payload = await target.push();
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  refresh: async ({ serverId, target }) => {
    await runCheckoutAction({
      serverId,
      target,
      actionId: "refresh",
      run: async () => {
        const payload = await target.refresh();
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  pullAndPush: async ({ serverId, target }) => {
    await runCheckoutAction({
      serverId,
      target,
      actionId: "pull-and-push",
      run: async () => {
        const pullPayload = await target.pull();
        if (pullPayload.error) {
          throw new Error(pullPayload.error.message);
        }
        const pushPayload = await target.push();
        if (pushPayload.error) {
          throw new Error(pushPayload.error.message);
        }
      },
    });
  },

  createPr: async ({ serverId, target }) => {
    await runCheckoutAction({
      serverId,
      target,
      actionId: "create-pr",
      run: async () => {
        const payload = await target.createPr({});
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  mergePr: async ({ serverId, target, method }) => {
    await runCheckoutAction({
      serverId,
      target,
      actionId: `merge-pr-${method}`,
      run: async () => {
        const payload = await target.mergePr(method);
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  enablePrAutoMerge: async ({ serverId, target, method }) => {
    const rpc = resolveAutoMergeActionsRpc(serverId);
    await runCheckoutAction({
      serverId,
      target,
      actionId: `enable-pr-auto-merge-${method}`,
      run: async () => {
        // COMPAT(githubAutoMergeRpc): added in v0.1.106, remove after 2026-12-28 once
        // all supported clients use checkout.forge.set_auto_merge.*.
        const payload =
          rpc === "forge"
            ? await target.setForgeAutoMerge({ enabled: true, method })
            : await target.setGithubAutoMerge({ enabled: true, method });
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  disablePrAutoMerge: async ({ serverId, target }) => {
    const rpc = resolveAutoMergeActionsRpc(serverId);
    await runCheckoutAction({
      serverId,
      target,
      actionId: "disable-pr-auto-merge",
      run: async () => {
        // COMPAT(githubAutoMergeRpc): added in v0.1.106, remove after 2026-12-28 once
        // all supported clients use checkout.forge.set_auto_merge.*.
        const payload =
          rpc === "forge"
            ? await target.setForgeAutoMerge({ enabled: false })
            : await target.setGithubAutoMerge({ enabled: false });
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  mergeBranch: async ({ serverId, target, baseRef }) => {
    await runCheckoutAction({
      serverId,
      target,
      actionId: "merge-branch",
      run: async () => {
        const payload = await target.merge({
          baseRef,
          strategy: "merge",
          requireCleanTarget: true,
        });
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  mergeFromBase: async ({ serverId, target, baseRef }) => {
    await runCheckoutAction({
      serverId,
      target,
      actionId: "merge-from-base",
      run: async () => {
        const payload = await target.mergeFromBase({
          baseRef,
          requireCleanTarget: true,
        });
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  discardChanges: async ({ serverId, target, paths }) => {
    await runCheckoutAction({
      serverId,
      target,
      actionId: "discard-changes",
      run: async () => {
        const payload = await target.discardChanges({ paths });
        if (!payload.success) {
          throw new Error(payload.error?.message ?? "Failed to discard changes");
        }
      },
    });
  },
}));

export function __resetCheckoutGitActionsStoreForTests() {
  for (const timer of successTimers.values()) {
    clearTimeout(timer);
  }
  successTimers.clear();
  inFlight.clear();
  useCheckoutGitActionsStore.setState({ statusByCheckout: {} });
}
