import type {
  CheckoutPrMergeMethod,
  ParsedDiffFile,
  SubscribeCheckoutDiffResponse,
} from "@getpaseo/protocol/messages";
import { create } from "zustand";
import { queryClient as appQueryClient } from "@/data/query-client";
import { useSessionStore } from "@/stores/session-store";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { i18n } from "@/i18n/i18next";

const SUCCESS_DISPLAY_MS = 1000;

type CheckoutDiffCachePayload = Omit<SubscribeCheckoutDiffResponse["payload"], "subscriptionId">;
type CheckoutDiffMode = "staged" | "unstaged";
type QueryKey = readonly unknown[];

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
  | "discard-changes"
  | "stage"
  | "unstage";

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

function invalidateCheckoutGitQueries(serverId: string, cwd: string) {
  return invalidateCheckoutGitQueriesForClient(appQueryClient, { serverId, cwd });
}

const successTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Map<string, Promise<unknown>>();
const indexMutationQueues = new Map<CheckoutKey, Promise<void>>();

function inFlightKey(key: CheckoutKey, actionId: CheckoutGitAsyncActionId): string {
  return `${key}::${actionId}`;
}

function isCheckoutDiffQueryKey(
  queryKey: QueryKey,
  input: { serverId: string; cwd: string; mode: CheckoutDiffMode },
): boolean {
  return (
    queryKey[0] === "checkoutDiff" &&
    queryKey[1] === input.serverId &&
    queryKey[2] === input.cwd &&
    queryKey[3] === input.mode
  );
}

function fileMatchesPaths(file: ParsedDiffFile, paths: ReadonlySet<string>): boolean {
  return paths.has(file.path) || (file.oldPath !== undefined && paths.has(file.oldPath));
}

function sortDiffFiles(files: ParsedDiffFile[]): ParsedDiffFile[] {
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function mergeOptimisticFiles(
  current: ParsedDiffFile[],
  incoming: ParsedDiffFile[],
): ParsedDiffFile[] {
  const byPath = new Map(current.map((file) => [file.path, file]));
  for (const file of incoming) {
    if (!byPath.has(file.path)) {
      byPath.set(file.path, file);
    }
  }
  return sortDiffFiles([...byPath.values()]);
}

function applyOptimisticIndexUpdate(input: {
  serverId: string;
  cwd: string;
  operation: "stage" | "unstage";
  paths?: string[];
  all?: boolean;
}): () => void {
  const sourceMode: CheckoutDiffMode = input.operation === "stage" ? "unstaged" : "staged";
  const destinationMode: CheckoutDiffMode = input.operation === "stage" ? "staged" : "unstaged";
  const requestedPaths = new Set(input.paths ?? []);
  const movedEntries: Array<{
    sourceQueryKey: QueryKey;
    destinationQueryKey: QueryKey;
    movedFiles: ParsedDiffFile[];
  }> = [];

  const sourceQueries = appQueryClient.getQueryCache().findAll({
    predicate: (query) =>
      isCheckoutDiffQueryKey(query.queryKey, {
        serverId: input.serverId,
        cwd: input.cwd,
        mode: sourceMode,
      }),
  });

  for (const sourceQuery of sourceQueries) {
    const sourcePayload = appQueryClient.getQueryData<CheckoutDiffCachePayload>(
      sourceQuery.queryKey,
    );
    if (!sourcePayload) {
      continue;
    }
    const movedFiles = sourcePayload.files.filter(
      (file) => input.all === true || fileMatchesPaths(file, requestedPaths),
    );
    if (movedFiles.length === 0) {
      continue;
    }
    const affectedPaths = new Set(
      movedFiles.flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path])),
    );
    const destinationKey = [...sourceQuery.queryKey];
    destinationKey[3] = destinationMode;
    const destinationPayload =
      appQueryClient.getQueryData<CheckoutDiffCachePayload>(destinationKey);

    appQueryClient.setQueryData<CheckoutDiffCachePayload>(sourceQuery.queryKey, {
      ...sourcePayload,
      files: sourcePayload.files.filter((file) => !fileMatchesPaths(file, affectedPaths)),
    });

    if (destinationPayload) {
      appQueryClient.setQueryData<CheckoutDiffCachePayload>(destinationKey, {
        ...destinationPayload,
        files: mergeOptimisticFiles(destinationPayload.files, movedFiles),
      });
    }

    movedEntries.push({
      sourceQueryKey: sourceQuery.queryKey,
      destinationQueryKey: destinationKey,
      movedFiles,
    });
  }

  return () => {
    // Reverse only the moved files that are still present in the destination
    // so that subsequent or opposite mutations touching the same path are preserved.
    for (const { sourceQueryKey, destinationQueryKey, movedFiles } of movedEntries) {
      const destinationPayload =
        appQueryClient.getQueryData<CheckoutDiffCachePayload>(destinationQueryKey);
      if (!destinationPayload) continue;

      const affectedPaths = new Set(
        movedFiles.flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path])),
      );
      const filesToRevert = destinationPayload.files.filter((file) =>
        fileMatchesPaths(file, affectedPaths),
      );
      if (filesToRevert.length === 0) continue;

      const pathsToRevert = new Set(
        filesToRevert.flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path])),
      );

      appQueryClient.setQueryData<CheckoutDiffCachePayload>(destinationQueryKey, {
        ...destinationPayload,
        files: destinationPayload.files.filter((file) => !fileMatchesPaths(file, pathsToRevert)),
      });
      appQueryClient.setQueryData<CheckoutDiffCachePayload>(sourceQueryKey, (current) => {
        if (!current) return current;
        return {
          ...current,
          files: mergeOptimisticFiles(current.files, filesToRevert),
        };
      });
    }
  };
}

function enqueueIndexMutation(
  serverId: string,
  cwd: string,
  run: () => Promise<void>,
): Promise<void> {
  const key = checkoutKey(serverId, cwd);
  const previous = indexMutationQueues.get(key) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(run);
  indexMutationQueues.set(key, queued);
  return queued.finally(() => {
    if (indexMutationQueues.get(key) === queued) {
      indexMutationQueues.delete(key);
      void invalidateCheckoutGitQueries(serverId, cwd).catch(() => undefined);
    }
  });
}

interface CheckoutGitActionsStoreState {
  statusByCheckout: Record<CheckoutKey, StatusMap>;

  getStatus: (params: {
    serverId: string;
    cwd: string;
    actionId: CheckoutGitAsyncActionId;
  }) => CheckoutGitActionStatus;

  commit: (params: {
    serverId: string;
    cwd: string;
    message?: string;
    files?: string[];
    addAll?: boolean;
  }) => Promise<void>;
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
  discardChanges: (params: { serverId: string; cwd: string; paths: string[] }) => Promise<void>;
  stage: (params: {
    serverId: string;
    cwd: string;
    paths?: string[];
    all?: boolean;
  }) => Promise<void>;
  unstage: (params: {
    serverId: string;
    cwd: string;
    paths?: string[];
    all?: boolean;
  }) => Promise<void>;
}

async function runCheckoutAction({
  serverId,
  cwd,
  actionId,
  run,
  dedupeSuffix,
  invalidateAfterSuccess = true,
}: {
  serverId: string;
  cwd: string;
  actionId: CheckoutGitAsyncActionId;
  run: () => Promise<void>;
  dedupeSuffix?: string;
  invalidateAfterSuccess?: boolean;
}): Promise<void> {
  const key = checkoutKey(serverId, cwd);
  const inflightId = `${inFlightKey(key, actionId)}${dedupeSuffix ? `::${dedupeSuffix}` : ""}`;

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
      if (invalidateAfterSuccess) {
        try {
          await invalidateCheckoutGitQueries(serverId, cwd);
        } catch {
          // Query refresh errors belong to their query surfaces; the Git mutation already succeeded.
        }
      }
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

  commit: async ({ serverId, cwd, message, files, addAll }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "commit",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutCommit(cwd, {
          ...(message ? { message } : null),
          ...(files ? { files } : { addAll: addAll ?? true }),
        });
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
    const rpc = resolveAutoMergeActionsRpc(serverId);
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: `enable-pr-auto-merge-${method}`,
      run: async () => {
        const client = resolveClient(serverId);
        // COMPAT(githubAutoMergeRpc): added in v0.1.106, remove after 2026-12-28 once
        // all supported clients use checkout.forge.set_auto_merge.*.
        const payload =
          rpc === "forge"
            ? await client.checkoutForgeSetAutoMerge(cwd, { enabled: true, method })
            : await client.checkoutGithubSetAutoMerge(cwd, { enabled: true, method });
        if (payload.error) {
          throw new Error(payload.error.message);
        }
      },
    });
  },

  disablePrAutoMerge: async ({ serverId, cwd }) => {
    const rpc = resolveAutoMergeActionsRpc(serverId);
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "disable-pr-auto-merge",
      run: async () => {
        const client = resolveClient(serverId);
        // COMPAT(githubAutoMergeRpc): added in v0.1.106, remove after 2026-12-28 once
        // all supported clients use checkout.forge.set_auto_merge.*.
        const payload =
          rpc === "forge"
            ? await client.checkoutForgeSetAutoMerge(cwd, { enabled: false })
            : await client.checkoutGithubSetAutoMerge(cwd, { enabled: false });
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

  discardChanges: async ({ serverId, cwd, paths }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "discard-changes",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutDiscardChanges(cwd, { paths });
        if (!payload.success) {
          throw new Error(
            payload.error?.message ?? i18n.t("workspace.fileActions.confirmRevert.failed"),
          );
        }
      },
    });
  },

  stage: async ({ serverId, cwd, paths, all }) => {
    const rollback = applyOptimisticIndexUpdate({ serverId, cwd, operation: "stage", paths, all });
    try {
      await runCheckoutAction({
        serverId,
        cwd,
        actionId: "stage",
        dedupeSuffix: all ? "all" : JSON.stringify([...new Set(paths ?? [])].sort()),
        invalidateAfterSuccess: false,
        run: () =>
          enqueueIndexMutation(serverId, cwd, async () => {
            const payload = await resolveClient(serverId).checkoutIndexUpdate(cwd, {
              operation: "stage",
              paths,
              all,
            });
            if (!payload.success) {
              throw new Error(payload.error?.message ?? "Unable to stage changes");
            }
          }),
      });
    } catch (error) {
      rollback();
      void invalidateCheckoutGitQueries(serverId, cwd).catch(() => undefined);
      throw error;
    }
  },

  unstage: async ({ serverId, cwd, paths, all }) => {
    const rollback = applyOptimisticIndexUpdate({
      serverId,
      cwd,
      operation: "unstage",
      paths,
      all,
    });
    try {
      await runCheckoutAction({
        serverId,
        cwd,
        actionId: "unstage",
        dedupeSuffix: all ? "all" : JSON.stringify([...new Set(paths ?? [])].sort()),
        invalidateAfterSuccess: false,
        run: () =>
          enqueueIndexMutation(serverId, cwd, async () => {
            const payload = await resolveClient(serverId).checkoutIndexUpdate(cwd, {
              operation: "unstage",
              paths,
              all,
            });
            if (!payload.success) {
              throw new Error(payload.error?.message ?? "Unable to unstage changes");
            }
          }),
      });
    } catch (error) {
      rollback();
      void invalidateCheckoutGitQueries(serverId, cwd).catch(() => undefined);
      throw error;
    }
  },
}));

export function __resetCheckoutGitActionsStoreForTests() {
  for (const timer of successTimers.values()) {
    clearTimeout(timer);
  }
  successTimers.clear();
  inFlight.clear();
  indexMutationQueues.clear();
  useCheckoutGitActionsStore.setState({ statusByCheckout: {} });
}
