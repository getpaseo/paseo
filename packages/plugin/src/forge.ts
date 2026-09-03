import type { ZodType } from "zod";

export interface PluginForgeSignInCommand {
  cli: string;
  command: string;
  hostnameFlag?: string;
}

export interface PluginForgeDefinition {
  id: string;
  displayName: string;
  changeRequestAbbrev: string;
  changeRequestNoun: string;
  changeRequestNumberPrefix: string;
  issueNumberPrefix: string;
  signIn: PluginForgeSignInCommand | null;
  cloudHosts?: readonly string[];
}

export type PluginForgeMergeMethod = "merge" | "squash" | "rebase";

export interface PluginForgeMergeCapability {
  directMergeReady: boolean;
  canEnableAutoMerge: boolean;
  autoMergeEnabled: boolean;
  canDisableAutoMerge: boolean;
  mergeBlockedByQueue: boolean;
  allowedMethods: PluginForgeMergeMethod[];
  preferredMethod: PluginForgeMergeMethod | null;
}

export type PluginForgeSpecificEnvelope = { forge: string } & Record<string, unknown>;

export interface PluginForgeFactsRegistration<
  TFacts extends PluginForgeSpecificEnvelope = PluginForgeSpecificEnvelope,
> {
  family: TFacts["forge"];
  schema: ZodType<TFacts>;
  deriveMergeCapability?(facts: TFacts): PluginForgeMergeCapability;
}

export interface PluginForgeFactsContribution {
  family: string;
  schema: ZodType;
  deriveMergeCapability?: (facts: unknown) => PluginForgeMergeCapability;
}

export interface PluginForgeUrlGrammar {
  treeInfix: string;
  blobInfix: string;
  lineAnchorStyle: "github" | "gitlab";
  changeRequestChecksSuffix?: string;
  referencePaths?: readonly PluginForgeReferencePath[];
}

export interface PluginForgeReferencePath {
  kind: "change_request" | "issue";
  infix: string;
}

export interface PluginForgeSvgPathIcon {
  kind: "svg-path";
  viewBox: readonly [minX: number, minY: number, width: number, height: number];
  path: string;
}

export interface PluginForgeClientView {
  icon: PluginForgeSvgPathIcon;
  brandColor?: { light: string; dark: string } | null;
}

export interface PluginForgeClientProviderContribution {
  definition: PluginForgeDefinition;
  facts?: PluginForgeFactsContribution;
  urlGrammar?: PluginForgeUrlGrammar;
  view?: PluginForgeClientView;
}

export function defineForgeFacts<TFacts extends PluginForgeSpecificEnvelope>(
  registration: PluginForgeFactsRegistration<TFacts>,
): PluginForgeFactsContribution {
  return {
    family: registration.family,
    schema: registration.schema,
    ...(registration.deriveMergeCapability
      ? {
          // The host parses facts through `schema` before calling this callback.
          // Parsing here as well would execute Zod transforms twice.
          deriveMergeCapability: (facts: unknown) =>
            registration.deriveMergeCapability?.(facts as TFacts) as PluginForgeMergeCapability,
        }
      : {}),
  };
}

export function defineForgeClientProvider<Definition extends PluginForgeClientProviderContribution>(
  definition: Definition,
): Definition {
  return definition;
}

export type ForgeSearchKind = "issue" | "change_request";
// COMPAT(githubSearchKind): added in v0.1.106, remove with the legacy
// github_search_request RPC after 2026-12-28.
export type ForgeSearchRequestKind = ForgeSearchKind | "github-issue" | "github-pr" | "pr";

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

export interface PullRequestCheckoutRef {
  remoteName?: string;
  remoteUrl?: string;
  remoteRef: string;
}

export interface PullRequestCheckoutTarget {
  number: number;
  baseRefName: string;
  headRefName: string;
  checkoutRefs?: PullRequestCheckoutRef[];
  headOwnerLogin: string | null;
  preferredPushUrl?: string;
  headRepositorySshUrl: string | null;
  headRepositoryUrl: string | null;
  isCrossRepository: boolean;
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
  traits?: string[];
}

export type PullRequestChecksStatus = "none" | "pending" | "success" | "failure";
export type PullRequestReviewDecision = "approved" | "changes_requested" | "pending" | null;
export type PullRequestMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
export type ForgeAuthState =
  | "authenticated"
  | "unauthenticated"
  | "cli_missing"
  | "no_remote"
  | "error";
export type ForgeSpecificStatusFacts = PluginForgeSpecificEnvelope;

export interface CurrentPullRequestStatus {
  number?: number;
  repoOwner?: string;
  repoName?: string;
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

export type PullRequestMergeMethod = PluginForgeMergeMethod;

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

export type ForgeReadOptions = { force?: false; reason?: string } | { force: true; reason: string };

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
  repoOwner?: string;
  repoName?: string;
  checkRunId?: number;
  workflowRunId?: number;
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
  githubFeaturesEnabled?: boolean;
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

export const PLUGIN_FORGE_SERVICE_METHODS = [
  "listPullRequests",
  "listIssues",
  "getPullRequest",
  "getPullRequestHeadRef",
  "getPullRequestCheckoutTarget",
  "defaultCheckoutRefs",
  "buildPrLocalBranchName",
  "getCurrentPullRequestStatus",
  "getPullRequestTimeline",
  "getCheckDetails",
  "searchIssuesAndPrs",
  "createPullRequest",
  "mergePullRequest",
  "enablePullRequestAutoMerge",
  "disablePullRequestAutoMerge",
  "isAuthenticated",
  "invalidate",
  "dispose",
] as const;

export type PluginForgeServiceMethod = (typeof PLUGIN_FORGE_SERVICE_METHODS)[number];

export interface PluginForgeServerService {
  listPullRequests(options: ListPullRequestsOptions): Promise<PullRequestSummary[]>;
  listIssues(options: ListIssuesOptions): Promise<IssueSummary[]>;
  getPullRequest(options: GetPullRequestOptions): Promise<PullRequestSummary>;
  getPullRequestHeadRef(options: GetPullRequestOptions): Promise<string>;
  getPullRequestCheckoutTarget(options: GetPullRequestOptions): Promise<PullRequestCheckoutTarget>;
  defaultCheckoutRefs?(params: {
    changeRequestNumber: number;
    headRef: string;
  }): PullRequestCheckoutRef[] | Promise<PullRequestCheckoutRef[]>;
  buildPrLocalBranchName?(params: {
    headRef: string;
    checkoutTarget: PullRequestCheckoutTarget;
  }): string | undefined | Promise<string | undefined>;
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
  isAuthenticated(options: { cwd: string } & ForgeReadOptions): Promise<boolean>;
  authProbeCanThrow?: boolean;
  invalidate(options: { cwd: string }): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export type ForgeService = PluginForgeServerService;

export interface PluginForgeServerProviderContribution {
  definition: PluginForgeDefinition;
  service: PluginForgeServerService;
  probeHost?: (host: string) => boolean | Promise<boolean>;
}

export interface PluginForgeServerProviderDescriptor {
  definition: PluginForgeDefinition;
  methods: PluginForgeServiceMethod[];
  authProbeCanThrow: boolean;
  supportsCrossRepoCheckoutWithoutRefs: boolean;
  hasProbeHost: boolean;
}

export function defineForgeServerProvider<Definition extends PluginForgeServerProviderContribution>(
  definition: Definition,
): Definition {
  return definition;
}

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

export function computeChecksStatus(checks: PullRequestCheck[]): PullRequestChecksStatus {
  if (checks.length === 0) return "none";
  if (checks.some((check) => check.status === "failure")) return "failure";
  if (checks.some((check) => check.status === "pending")) return "pending";
  return "success";
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

export function parseOptionalTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareTimelineItems(
  left: Pick<PullRequestTimelineItem, "createdAt" | "id">,
  right: Pick<PullRequestTimelineItem, "createdAt" | "id">,
): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

export type PluginForgeErrorKind = "missing-cli" | "auth-failure" | "command-error";

export interface ForgeCommandFailureParams {
  args: string[];
  cwd: string;
  exitCode: number | null;
  stderr: string;
}

export class ForgeCliMissingError extends Error {
  readonly kind = "missing-cli" as const;
}

export class ForgeAuthenticationError extends Error {
  readonly kind = "auth-failure" as const;
  readonly stderr: string;

  constructor(message: string, params: { stderr: string }) {
    super(message);
    this.stderr = params.stderr;
    Object.defineProperty(this, "stderr", { enumerable: false });
  }
}

export class ForgeCommandError extends Error {
  readonly kind = "command-error" as const;
  readonly brand: string;
  readonly binary: string;
  readonly args: string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(label: { brand: string; binary: string }, params: ForgeCommandFailureParams) {
    super(`${label.brand} CLI command failed: ${label.binary}`);
    this.brand = label.brand;
    this.binary = label.binary;
    this.args = [...params.args];
    this.cwd = params.cwd;
    this.exitCode = params.exitCode;
    this.stderr = params.stderr;
    for (const key of ["brand", "binary", "args", "cwd", "stderr"] as const) {
      Object.defineProperty(this, key, { enumerable: false });
    }
  }
}

export interface PluginForgeSerializedError {
  message: string;
  name?: string;
  kind?: PluginForgeErrorKind;
  stderr?: string;
  args?: string[];
  cwd?: string;
  exitCode?: number | null;
  brand?: string;
  binary?: string;
}
