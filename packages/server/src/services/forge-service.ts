import type { ForgeSearchKind } from "@getpaseo/protocol/messages";

export type ForgeSearchRequestKind = ForgeSearchKind | "github-issue" | "github-pr" | "pr";

export function normalizeForgeSearchKinds(
  kinds: readonly ForgeSearchRequestKind[] | undefined,
): ForgeSearchKind[] {
  if (!kinds) return ["issue", "change_request"];

  return kinds.map((kind) => {
    // COMPAT(githubSearchKind): added in v0.1.106, remove with the legacy
    // github_search_request RPC after 2026-12-28.
    if (kind === "github-issue") return "issue";
    if (kind === "github-pr" || kind === "pr") return "change_request";
    return kind;
  });
}

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  body: string | null;
  projectPath?: string;
  baseRefName: string;
  headRefName: string;
  labels: string[];
  updatedAt: string;
}

export interface PullRequestCheckoutTarget {
  number: number;
  baseRefName: string;
  headRefName: string;
  checkoutRefs?: PullRequestCheckoutRef[];
  headOwnerLogin: string | null;
  headRepositorySshUrl: string | null;
  headRepositoryUrl: string | null;
  isCrossRepository: boolean;
}

export interface PullRequestCheckoutRef {
  remoteName?: string;
  remoteRef: string;
}

export interface IssueSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  body: string | null;
  projectPath?: string;
  labels: string[];
  updatedAt: string;
}

export type PullRequestCheckStatus = "pending" | "success" | "failure" | "cancelled" | "skipped";

export interface PullRequestCheck {
  name: string;
  status: PullRequestCheckStatus;
  url: string | null;
  workflow?: string;
  duration?: string;
  checkRunId?: number;
  workflowRunId?: number;
}

export type PullRequestChecksStatus = "none" | "pending" | "success" | "failure";
export type PullRequestReviewDecision = "approved" | "changes_requested" | "pending" | null;
export type PullRequestMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export function computeChecksStatus(checks: PullRequestCheck[]): PullRequestChecksStatus {
  if (checks.length === 0) {
    return "none";
  }
  if (checks.some((check) => check.status === "failure")) {
    return "failure";
  }
  if (checks.some((check) => check.status === "pending")) {
    return "pending";
  }
  return "success";
}

/**
 * Why a forge's PR/MR features are (un)available for a workspace. Replaces the
 * lossy "authenticated yes/no" boolean so the UI can offer the precise next step
 * (install the CLI vs sign in) instead of a single generic dead-end. "no_remote"
 * covers anything where the feature simply does not apply (no resolvable forge
 * remote, or no branch to look up). "error" is reserved for non-auth failures
 * where the UI should show the actual error instead of setup guidance.
 */
export type ForgeAuthState =
  | "authenticated"
  | "unauthenticated"
  | "cli_missing"
  | "no_remote"
  | "error";

/**
 * Open envelope for a forge's native merge facts on the neutral PR status.
 * Per-adapter modules own their typed fact interfaces and guards; shared server
 * code only requires the runtime facts-family tag.
 */
export type ForgeSpecificStatusFacts = { forge: string } & Record<string, unknown>;

export interface CurrentPullRequestStatus {
  number?: number;
  repoOwner?: string;
  repoName?: string;
  /**
   * The forge's full project path (e.g. nested GitLab namespaces like
   * `group/subgroup/repo`). Adapters that can report it precisely set it here;
   * otherwise consumers fall back to deriving it from owner/name.
   */
  projectPath?: string;
  url: string;
  title: string;
  state: string;
  baseRefName: string;
  headRefName: string;
  isMerged: boolean;
  isDraft?: boolean;
  mergeable: PullRequestMergeable;
  checks: PullRequestCheck[];
  checksStatus: PullRequestChecksStatus;
  reviewDecision: PullRequestReviewDecision;
  forgeSpecific?: ForgeSpecificStatusFacts;
}

export type PullRequestTimelineReviewState = "approved" | "changes_requested" | "commented";

interface PullRequestTimelineItemBase {
  id: string;
  author: string;
  authorUrl: string | null;
  avatarUrl: string | null;
  body: string;
  createdAt: number;
  url: string;
}

export type PullRequestTimelineItem =
  | (PullRequestTimelineItemBase & {
      kind: "review";
      reviewState: PullRequestTimelineReviewState;
    })
  | (PullRequestTimelineItemBase & {
      kind: "comment";
      reviewId?: string;
      threadId?: string;
      threadIsResolved?: boolean;
      location?: PullRequestTimelineCommentLocation;
    });

export interface PullRequestTimelineCommentLocation {
  path: string;
  line?: number;
  startLine?: number;
  threadId?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
}

export type PullRequestTimelineErrorKind = "not_found" | "forbidden" | "unknown";

export interface PullRequestTimelineError {
  kind: PullRequestTimelineErrorKind;
  message: string;
}

export interface PullRequestTimeline {
  prNumber: number;
  repoOwner: string;
  repoName: string;
  items: PullRequestTimelineItem[];
  truncated: boolean;
  error: PullRequestTimelineError | null;
}

export interface PullRequestCreateResult {
  url: string;
  number: number;
}

export type PullRequestMergeMethod = "merge" | "squash" | "rebase";

export interface PullRequestCommandStatus {
  mergeable?: PullRequestMergeable;
  forgeSpecific?: ForgeSpecificStatusFacts;
}

export interface MergePullRequestOptions {
  cwd: string;
  prNumber: number;
  mergeMethod: PullRequestMergeMethod;
  status?: PullRequestCommandStatus | null;
}

export interface EnablePullRequestAutoMergeOptions {
  cwd: string;
  prNumber: number;
  mergeMethod: PullRequestMergeMethod;
  status?: PullRequestCommandStatus | null;
}

export interface DisablePullRequestAutoMergeOptions {
  cwd: string;
  prNumber: number;
  status?: PullRequestCommandStatus | null;
}

export interface PullRequestMergeResult {
  success: true;
}

export interface PullRequestAutoMergeResult {
  success: true;
}

export type ForgeReadOptions =
  | {
      force?: false;
      reason?: string;
    }
  | {
      force: true;
      reason: string;
    };

export type ListPullRequestsOptions = {
  cwd: string;
  query?: string;
  limit?: number;
} & ForgeReadOptions;

export type ListIssuesOptions = {
  cwd: string;
  query?: string;
  limit?: number;
} & ForgeReadOptions;

export type GetPullRequestOptions = {
  cwd: string;
  number: number;
} & ForgeReadOptions;

export type GetPullRequestTimelineOptions = {
  cwd: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
} & ForgeReadOptions;

export type GetCheckDetailsOptions = {
  cwd: string;
  /**
   * GitHub-only: the GitHub adapter addresses the check run by owner/name. The
   * GitLab adapter resolves the project from the cwd's remote and ignores these.
   */
  repoOwner?: string;
  repoName?: string;
  /**
   * Check-run id. Optional because some checks are addressed only by
   * workflowRunId (Gitea Actions runs carry no check-run id). Callers pass at
   * least one of checkRunId/workflowRunId.
   */
  checkRunId?: number;
  workflowRunId?: number;
  /**
   * Change request number used when check details must resolve against a
   * specific request rather than the current branch. GitLab routes the fetch to
   * the MR's head pipeline; Gitea-family adapters resolve the PR head SHA by
   * number, including for terminal PRs. GitHub ignores it.
   */
  changeRequestNumber?: number;
} & ForgeReadOptions;

export interface CheckAnnotation {
  path?: string;
  startLine?: number;
  endLine?: number;
  annotationLevel?: string;
  message?: string;
  title?: string;
  rawDetails?: string;
}

export interface CheckFailedJob {
  jobId: number;
  name: string;
  status?: string | null;
  conclusion?: string | null;
  url?: string | null;
  completedAt?: string;
  logTail?: string;
  logTruncated?: boolean;
}

/**
 * Normalized lifecycle of a CI job/pipeline, neutral across forges. Adapters
 * map their forge's raw status strings onto this; readers keep the raw string
 * too (see {@link PipelineJob.rawStatus}) for display fidelity.
 */
export type PipelineJobStatus =
  | "success"
  | "failed"
  | "running"
  | "pending"
  | "canceled"
  | "skipped"
  | "manual"
  | "created"
  | "unknown";

export interface PipelineJob {
  id: number;
  name: string;
  stage: string;
  status: PipelineJobStatus;
  rawStatus: string;
  url: string | null;
  allowFailure: boolean;
  durationSeconds: number | null;
}

export interface PipelineStage {
  name: string;
  status: PipelineJobStatus;
  jobs: PipelineJob[];
}

/**
 * A CI pipeline as a stage → job tree. Forges that model CI as a pipeline
 * (GitLab) populate this; forges that model it as flat check runs (GitHub)
 * leave {@link CheckDetails.pipeline} undefined and use the check-run fields.
 */
export interface PipelineDetails {
  id: number;
  status: PipelineJobStatus;
  rawStatus: string;
  url: string | null;
  ref: string | null;
  sha: string | null;
  stages: PipelineStage[];
}

export interface CheckDetails {
  checkRunId: number;
  workflowRunId?: number | null;
  name: string;
  status?: string | null;
  conclusion?: string | null;
  url?: string | null;
  detailsUrl?: string | null;
  output?: {
    title?: string | null;
    summary?: string | null;
    text?: string | null;
  } | null;
  annotations: CheckAnnotation[];
  failedJobs: CheckFailedJob[];
  truncated: boolean;
  /**
   * Structured pipeline (stages → jobs) for forges that model CI as a pipeline.
   * GitLab populates it; GitHub leaves it undefined and keeps using the flat
   * check-run fields above.
   */
  pipeline?: PipelineDetails | null;
}

export interface SearchResult {
  items: Array<{
    kind: "issue" | "change_request";
    forge?: string;
    number: number;
    title: string;
    url: string;
    state: string;
    body: string | null;
    labels: string[];
    projectPath?: string;
    baseRefName?: string | null;
    headRefName?: string | null;
    updatedAt?: string;
  }>;
  featuresEnabled: boolean;
  authState: ForgeAuthState;
  /**
   * COMPAT(githubFeaturesEnabled): added in v0.1.106, remove after 2026-12-28.
   */
  githubFeaturesEnabled?: boolean;
}

export function createUnavailableSearchResult(
  authState: Exclude<ForgeAuthState, "authenticated">,
): SearchResult {
  return {
    items: [],
    featuresEnabled: false,
    authState,
    githubFeaturesEnabled: false,
  };
}

export type SearchIssuesAndPrsOptions = {
  cwd: string;
  query: string;
  limit?: number;
  kinds?: ForgeSearchRequestKind[];
} & ForgeReadOptions;

export interface CreatePullRequestOptions {
  cwd: string;
  title: string;
  head: string;
  base: string;
  body?: string;
}

export interface ForgeService {
  listPullRequests(options: ListPullRequestsOptions): Promise<PullRequestSummary[]>;
  listIssues(options: ListIssuesOptions): Promise<IssueSummary[]>;
  getPullRequest(options: GetPullRequestOptions): Promise<PullRequestSummary>;
  getPullRequestHeadRef(options: GetPullRequestOptions): Promise<string>;
  getPullRequestCheckoutTarget(options: GetPullRequestOptions): Promise<PullRequestCheckoutTarget>;
  /**
   * Refs to fetch for a change-request checkout when the resolved checkout
   * target carries none. Adapters that expose a universal change-request head
   * ref (GitHub's refs/pull/N/head) return it here; others let the shell fall
   * back to the head branch.
   */
  defaultCheckoutRefs?(params: {
    changeRequestNumber: number;
    headRef: string;
  }): PullRequestCheckoutRef[];
  /**
   * Local branch name for a checked-out change request when the adapter
   * disambiguates cross-repository heads (GitHub prefixes the fork owner).
   * Returns undefined to keep the head ref name as-is.
   */
  buildPrLocalBranchName?(params: {
    headRef: string;
    checkoutTarget: PullRequestCheckoutTarget;
  }): string | undefined;
  /**
   * True when the adapter can fetch a cross-repository change-request head with
   * no explicit refs on the checkout target (GitHub via refs/pull/N/head).
   * Others reject a cross-repo checkout that carries no refs.
   */
  supportsCrossRepoCheckoutWithoutRefs?: boolean;
  getCurrentPullRequestStatus(
    options: {
      cwd: string;
      headRef: string;
      headSha?: string;
      headRepositoryOwner?: string;
    } & ForgeReadOptions,
  ): Promise<CurrentPullRequestStatus | null>;
  getPullRequestTimeline(options: GetPullRequestTimelineOptions): Promise<PullRequestTimeline>;
  getCheckDetails(options: GetCheckDetailsOptions): Promise<CheckDetails>;
  searchIssuesAndPrs(options: SearchIssuesAndPrsOptions): Promise<SearchResult>;
  createPullRequest(options: CreatePullRequestOptions): Promise<PullRequestCreateResult>;
  mergePullRequest(options: MergePullRequestOptions): Promise<PullRequestMergeResult>;
  enablePullRequestAutoMerge(
    options: EnablePullRequestAutoMergeOptions,
  ): Promise<PullRequestAutoMergeResult>;
  disablePullRequestAutoMerge(
    options: DisablePullRequestAutoMergeOptions,
  ): Promise<PullRequestAutoMergeResult>;
  /**
   * Check whether the adapter can authenticate against the forge for `cwd`.
   * An adapter picks exactly one of two contracts:
   *
   * - Resolve to `false` on any auth failure (missing CLI, expired token,
   *   unreachable host, ...) and never reject. This is the default contract;
   *   most adapters should implement it this way.
   * - Reject with a classified error distinguishing the failure kind (e.g.
   *   "CLI not installed" vs "not logged in") instead of collapsing
   *   everything to `false`. An adapter that does this MUST also set
   *   {@link authProbeCanThrow} to `true`, or callers have no way to know the
   *   rejection is meaningful and will treat it as an unhandled error.
   */
  isAuthenticated(options: { cwd: string } & ForgeReadOptions): Promise<boolean>;
  /**
   * True when isAuthenticated() throws a classified error (missing CLI /
   * auth failure) on failure instead of just resolving to false. Callers that
   * want the precise failure kind before falling back to a PR-status lookup
   * (which can't distinguish "unauthenticated" from "no PR found") should
   * only probe isAuthenticated() when this is set — otherwise the call
   * cannot change the outcome and is pure overhead.
   */
  authProbeCanThrow?: boolean;
  retainCurrentPullRequestStatusPoll?(options: {
    cwd: string;
    headRef: string;
    headSha?: string;
    headRepositoryOwner?: string;
    onStatus?: (status: CurrentPullRequestStatus | null) => void;
    onError?: (error: unknown) => void;
  }): { unsubscribe: () => void };
  invalidate(options: { cwd: string }): void;
  dispose?(): void;
}

/** Parse an optional ISO timestamp to epoch ms, 0 when absent or unparseable. */
export function parseOptionalTime(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Stable timeline ordering shared by every adapter: by createdAt, then id. */
export function compareTimelineItems(
  left: PullRequestTimelineItem,
  right: PullRequestTimelineItem,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}
