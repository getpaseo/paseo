import type { CheckoutPrMergeMethod } from "@getpaseo/protocol/messages";
import { create } from "zustand";
import { queryClient as appQueryClient } from "@/data/query-client";
import { useSessionStore } from "@/stores/session-store";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { i18n } from "@/i18n/i18next";

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
  | "merge-from-base";

type CheckoutKey = string;
type StatusMap = Partial<Record<CheckoutGitAsyncActionId, CheckoutGitActionStatus>>;

function checkoutKey(serverId: string, cwd: string): CheckoutKey {
  return `${serverId}::${cwd}`;
}

function resolveClient(serverId: string) {
  const session = useSessionStore.getState().sessions[serverId];
  const client = session?.client ?? null;
  if (!client) {
    throw new Error(i18n.t("common.errors.daemonClientUnavailable"));
  }
  return client;
}

function assertGitHubAutoMergeActionsSupported(serverId: string) {
  const session = useSessionStore.getState().sessions[serverId];
  if (session?.serverInfo?.features?.checkoutGithubSetAutoMerge !== true) {
    throw new Error("Update the host to use GitHub auto-merge actions.");
  }
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

function invalidateCheckoutGitQueries(serverId: string, cwd: string) {
  return invalidateCheckoutGitQueriesForClient(appQueryClient, { serverId, cwd });
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
    cwd: string;
    actionId: CheckoutGitAsyncActionId;
  }) => CheckoutGitActionStatus;

  commit: (params: { serverId: string; cwd: string }) => Promise<void>;
  pull: (params: { serverId: string; cwd: string }) => Promise<void>;
  push: (params: { serverId: string; cwd: string }) => Promise<void>;
  pullAndPush: (params: { serverId: string; cwd: string }) => Promise<void>;
  refresh: (params: { serverId: string; cwd: string }) => Promise<void>;
  createPr: (params: { serverId: string; cwd: string }) => Promise<void>;
  mergePr: (params: {
    serverId: string;
    cwd: string;
    method: CheckoutPrMergeMethod;
  }) => Promise<void>;
  enablePrAutoMerge: (params: {
    serverId: string;
    cwd: string;
    method: CheckoutPrMergeMethod;
  }) => Promise<void>;
  disablePrAutoMerge: (params: { serverId: string; cwd: string }) => Promise<void>;
  mergeBranch: (params: { serverId: string; cwd: string; baseRef: string }) => Promise<void>;
  mergeFromBase: (params: { serverId: string; cwd: string; baseRef: string }) => Promise<void>;
}

async function runCheckoutAction({
  serverId,
  cwd,
  actionId,
  run,
}: {
  serverId: string;
  cwd: string;
  actionId: CheckoutGitAsyncActionId;
  run: () => Promise<void>;
}): Promise<void> {
  const key = checkoutKey(serverId, cwd);
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
      await invalidateCheckoutGitQueries(serverId, cwd);
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

  getStatus: ({ serverId, cwd, actionId }) => {
    const key = checkoutKey(serverId, cwd);
    return get().statusByCheckout[key]?.[actionId] ?? "idle";
  },

  commit: async ({ serverId, cwd }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "commit",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutCommit(cwd, { addAll: true });
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  pull: async ({ serverId, cwd }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "pull",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutPull(cwd);
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  push: async ({ serverId, cwd }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "push",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutPush(cwd);
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  refresh: async ({ serverId, cwd }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "refresh",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutRefresh(cwd);
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  pullAndPush: async ({ serverId, cwd }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "pull-and-push",
      run: async () => {
        const client = resolveClient(serverId);
        const pullPayload = await client.checkoutPull(cwd);
        if (pullPayload.error) {
          throw new Error(pullPayload.error.message);
        }
        const pushPayload = await client.checkoutPush(cwd);
        if (pushPayload.error) {
          throw new Error(pushPayload.error.message);
        }
      },
    });
  },

  createPr: async ({ serverId, cwd }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "create-pr",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutPrCreate(cwd, {});
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  mergePr: async ({ serverId, cwd, method }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: `merge-pr-${method}`,
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutPrMerge(cwd, { method });
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  enablePrAutoMerge: async ({ serverId, cwd, method }) => {
    assertGitHubAutoMergeActionsSupported(serverId);
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: `enable-pr-auto-merge-${method}`,
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutGithubSetAutoMerge(cwd, { enabled: true, method });
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  disablePrAutoMerge: async ({ serverId, cwd }) => {
    assertGitHubAutoMergeActionsSupported(serverId);
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "disable-pr-auto-merge",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutGithubSetAutoMerge(cwd, { enabled: false });
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  mergeBranch: async ({ serverId, cwd, baseRef }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "merge-branch",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutMerge(cwd, {
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

  mergeFromBase: async ({ serverId, cwd, baseRef }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "merge-from-base",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutMergeFromBase(cwd, {
          baseRef,
          requireCleanTarget: true,
        });
        if (payload.error) {
          throw new Error(payload.error.message);
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
