import type { ChangeRequestSource } from "./change-request-source.js";
/**
 * The daemon's Forge contract.
 *
 * The data shapes and the neutral half of the service live in the plugin SDK,
 * because a Forge plugin has to implement exactly the same contract from
 * outside this package. They were maintained here as a second hand-written copy
 * until the two could drift without anything failing; the SDK is now the single
 * source and this module is the daemon's view of it.
 */
export {
  compareTimelineItems,
  computeChecksStatus,
  createUnavailableSearchResult,
  normalizeForgeSearchKinds,
  parseOptionalTime,
} from "@getpaseo/plugin/server";
export type {
  CheckAnnotation,
  CheckDetails,
  CheckFailedJob,
  CreatePullRequestOptions,
  CurrentPullRequestStatus,
  DisablePullRequestAutoMergeOptions,
  EnablePullRequestAutoMergeOptions,
  ForgeAuthState,
  ForgeReadOptions,
  ForgeSearchRequestKind,
  ForgeSpecificStatusFacts,
  GetCheckDetailsOptions,
  GetPullRequestOptions,
  GetPullRequestTimelineOptions,
  IssueSummary,
  ListIssuesOptions,
  ListPullRequestsOptions,
  MergePullRequestOptions,
  PipelineDetails,
  PipelineJob,
  PipelineJobStatus,
  PipelineStage,
  PullRequestAutoMergeResult,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestCheckoutRef,
  PullRequestCheckoutTarget,
  PullRequestChecksStatus,
  PullRequestCommandStatus,
  PullRequestCreateResult,
  PullRequestMergeMethod,
  PullRequestMergeResult,
  PullRequestMergeable,
  PullRequestReviewDecision,
  PullRequestSummary,
  PullRequestTimeline,
  PullRequestTimelineCommentLocation,
  PullRequestTimelineError,
  PullRequestTimelineErrorKind,
  PullRequestTimelineItem,
  PullRequestTimelineReviewState,
  SearchIssuesAndPrsOptions,
  SearchResult,
} from "@getpaseo/plugin/server";

import type {
  CurrentPullRequestStatus,
  ForgeReadOptions,
  PluginForgeServerService,
} from "@getpaseo/plugin/server";

/**
 * A built-in adapter. It implements the plugin-facing contract plus the pieces
 * that only make sense in-process: a long-lived status poll the daemon can hold
 * open, and a synchronous `invalidate` (a plugin's crosses a process boundary,
 * so the SDK lets it return a promise).
 */
export interface CurrentPullRequestLookup {
  cwd: string;
  headRef: string;
  headSha?: string;
  headRepositoryOwner?: string;
  /** Local branch name when it differs from the PR source ref. */
  currentBranch?: string;
}

export function isOnDefaultBranch(
  lookup: Pick<CurrentPullRequestLookup, "currentBranch" | "headRef">,
  defaultBranch: string | null | undefined,
): boolean {
  return (lookup.currentBranch ?? lookup.headRef) === defaultBranch;
}

export interface ForgeService extends PluginForgeServerService {
  getReferenceRepository?(options: { cwd: string } & ForgeReadOptions): Promise<string | null>;
  getCurrentPullRequestStatus(
    options: CurrentPullRequestLookup & ForgeReadOptions,
  ): Promise<CurrentPullRequestStatus | null>;
  retainCurrentPullRequestStatusPoll?(
    options: CurrentPullRequestLookup & {
      onStatus?: (status: CurrentPullRequestStatus | null) => void;
      onError?: (error: unknown) => void;
    },
  ): { unsubscribe: () => void };
  changeRequests?: ChangeRequestSource;
  invalidate(options: { cwd: string }): void;
}
