import type pino from "pino";
import type {
  PluginForgeServerProviderDescriptor,
  PluginForgeServiceMethod,
} from "@getpaseo/plugin/server";
import type { ForgeService, PullRequestCheckoutRef } from "../../services/forge-service.js";

export interface PluginForgeInvoker {
  invokeForge(
    pluginId: string,
    providerId: string,
    method: PluginForgeServiceMethod | "probeHost",
    input: unknown,
  ): Promise<unknown>;
}

export interface PluginForgeServiceProxy {
  service: ForgeService;
  probeHost?: (host: string) => Promise<boolean>;
}

export function createPluginForgeServiceProxy(options: {
  pluginId: string;
  descriptor: PluginForgeServerProviderDescriptor;
  invoker: PluginForgeInvoker;
  logger: pino.Logger;
}): PluginForgeServiceProxy {
  const providerId = options.descriptor.definition.id;
  const pendingInvalidations = new Map<string, Promise<void>>();

  async function invoke(method: PluginForgeServiceMethod, input: unknown): Promise<unknown> {
    return options.invoker.invokeForge(options.pluginId, providerId, method, input);
  }

  async function waitForInvalidation(cwd: string): Promise<void> {
    while (true) {
      const pending = pendingInvalidations.get(cwd);
      if (!pending) {
        return;
      }
      try {
        await pending;
      } catch (error) {
        if (pendingInvalidations.get(cwd) !== pending) {
          continue;
        }
        throw error;
      }
      if (pendingInvalidations.get(cwd) === pending) {
        return;
      }
    }
  }

  async function invokeForCwd<T>(
    method: PluginForgeServiceMethod,
    input: { cwd: string },
  ): Promise<T> {
    await waitForInvalidation(input.cwd);
    return (await invoke(method, input)) as T;
  }

  /**
   * Every cwd-scoped method forwards identically. Naming each one keeps the
   * object literal checked against `ForgeService`, so a method added to the
   * contract still fails to compile here until it is forwarded.
   */
  function forward<M extends PluginForgeServiceMethod & keyof ForgeService>(
    method: M,
  ): ForgeService[M] {
    return ((input: { cwd: string }) => invokeForCwd(method, input)) as ForgeService[M];
  }

  const service: ForgeService = {
    authProbeCanThrow: options.descriptor.authProbeCanThrow,
    supportsCrossRepoCheckoutWithoutRefs: options.descriptor.supportsCrossRepoCheckoutWithoutRefs,
    listPullRequests: forward("listPullRequests"),
    listIssues: forward("listIssues"),
    getPullRequest: forward("getPullRequest"),
    getPullRequestHeadRef: forward("getPullRequestHeadRef"),
    getPullRequestCheckoutTarget: forward("getPullRequestCheckoutTarget"),
    getCurrentPullRequestStatus: forward("getCurrentPullRequestStatus"),
    getPullRequestTimeline: forward("getPullRequestTimeline"),
    getCheckDetails: forward("getCheckDetails"),
    searchIssuesAndPrs: forward("searchIssuesAndPrs"),
    createPullRequest: forward("createPullRequest"),
    mergePullRequest: forward("mergePullRequest"),
    enablePullRequestAutoMerge: forward("enablePullRequestAutoMerge"),
    disablePullRequestAutoMerge: forward("disablePullRequestAutoMerge"),
    isAuthenticated: forward("isAuthenticated"),
    invalidate(input): void {
      const previous = pendingInvalidations.get(input.cwd) ?? Promise.resolve();
      const pending = previous
        .catch(() => undefined)
        .then(() => invoke("invalidate", input))
        .then(() => undefined);
      pendingInvalidations.set(input.cwd, pending);
      void pending.then(
        () => {
          if (pendingInvalidations.get(input.cwd) === pending) {
            pendingInvalidations.delete(input.cwd);
          }
          return undefined;
        },
        (error) => {
          options.logger.warn(
            { err: error, pluginId: options.pluginId, providerId, cwd: input.cwd },
            "Plugin forge invalidation failed",
          );
          return undefined;
        },
      );
    },
  };

  if (options.descriptor.methods.includes("defaultCheckoutRefs")) {
    service.defaultCheckoutRefs = async (input): Promise<PullRequestCheckoutRef[]> =>
      (await invoke("defaultCheckoutRefs", input)) as PullRequestCheckoutRef[];
  }
  if (options.descriptor.methods.includes("buildPrLocalBranchName")) {
    service.buildPrLocalBranchName = async (input): Promise<string | undefined> =>
      (await invoke("buildPrLocalBranchName", input)) as string | undefined;
  }
  if (options.descriptor.methods.includes("dispose")) {
    service.dispose = async (): Promise<void> => {
      await invoke("dispose", undefined);
    };
  }

  return {
    service,
    ...(options.descriptor.hasProbeHost
      ? {
          probeHost: async (host: string): Promise<boolean> =>
            (await options.invoker.invokeForge(options.pluginId, providerId, "probeHost", host)) ===
            true,
        }
      : {}),
  };
}
