import type pino from "pino";
import type {
  PluginForgeServerProviderDescriptor,
  PluginForgeServiceMethod,
} from "@getpaseo/plugin/server";
import type {
  CheckDetails,
  CreatePullRequestOptions,
  CurrentPullRequestStatus,
  DisablePullRequestAutoMergeOptions,
  EnablePullRequestAutoMergeOptions,
  ForgeService,
  GetCheckDetailsOptions,
  GetPullRequestOptions,
  GetPullRequestTimelineOptions,
  IssueSummary,
  ListIssuesOptions,
  ListPullRequestsOptions,
  MergePullRequestOptions,
  PullRequestAutoMergeResult,
  PullRequestCheckoutRef,
  PullRequestCheckoutTarget,
  PullRequestCreateResult,
  PullRequestMergeResult,
  PullRequestSummary,
  PullRequestTimeline,
  SearchIssuesAndPrsOptions,
  SearchResult,
} from "../../services/forge-service.js";

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

  const service: ForgeService = {
    authProbeCanThrow: options.descriptor.authProbeCanThrow,
    supportsCrossRepoCheckoutWithoutRefs: options.descriptor.supportsCrossRepoCheckoutWithoutRefs,
    listPullRequests(input: ListPullRequestsOptions): Promise<PullRequestSummary[]> {
      return invokeForCwd("listPullRequests", input);
    },
    listIssues(input: ListIssuesOptions): Promise<IssueSummary[]> {
      return invokeForCwd("listIssues", input);
    },
    getPullRequest(input: GetPullRequestOptions): Promise<PullRequestSummary> {
      return invokeForCwd("getPullRequest", input);
    },
    getPullRequestHeadRef(input: GetPullRequestOptions): Promise<string> {
      return invokeForCwd("getPullRequestHeadRef", input);
    },
    getPullRequestCheckoutTarget(input: GetPullRequestOptions): Promise<PullRequestCheckoutTarget> {
      return invokeForCwd("getPullRequestCheckoutTarget", input);
    },
    getCurrentPullRequestStatus(input): Promise<CurrentPullRequestStatus | null> {
      return invokeForCwd("getCurrentPullRequestStatus", input);
    },
    getPullRequestTimeline(input: GetPullRequestTimelineOptions): Promise<PullRequestTimeline> {
      return invokeForCwd("getPullRequestTimeline", input);
    },
    getCheckDetails(input: GetCheckDetailsOptions): Promise<CheckDetails> {
      return invokeForCwd("getCheckDetails", input);
    },
    searchIssuesAndPrs(input: SearchIssuesAndPrsOptions): Promise<SearchResult> {
      return invokeForCwd("searchIssuesAndPrs", input);
    },
    createPullRequest(input: CreatePullRequestOptions): Promise<PullRequestCreateResult> {
      return invokeForCwd("createPullRequest", input);
    },
    mergePullRequest(input: MergePullRequestOptions): Promise<PullRequestMergeResult> {
      return invokeForCwd("mergePullRequest", input);
    },
    enablePullRequestAutoMerge(
      input: EnablePullRequestAutoMergeOptions,
    ): Promise<PullRequestAutoMergeResult> {
      return invokeForCwd("enablePullRequestAutoMerge", input);
    },
    disablePullRequestAutoMerge(
      input: DisablePullRequestAutoMergeOptions,
    ): Promise<PullRequestAutoMergeResult> {
      return invokeForCwd("disablePullRequestAutoMerge", input);
    },
    isAuthenticated(input): Promise<boolean> {
      return invokeForCwd("isAuthenticated", input);
    },
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
