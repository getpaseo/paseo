import { z } from "zod";
import pLimit from "p-limit";
import { parseGitHubRemoteIdentity, parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { execCommand } from "../utils/spawn.js";
import {
  createCachedCliPathResolver,
  createForgeCliRunner,
  ForgeAuthenticationError,
  ForgeCliMissingError,
  CLI_AUTH_PROBE_TIMEOUT_MS,
  defaultResolveRemoteUrl,
  parseCliJsonOutput,
  ForgeCommandError,
  type ForgeCommandFailureParams,
} from "./forge-cli-command.js";
import {
  computeChecksStatus,
  compareTimelineItems,
  createUnavailableSearchResult,
  normalizeForgeSearchKinds,
  parseOptionalTime,
} from "./forge-service.js";
import type {
  CheckDetails,
  CreatePullRequestOptions,
  CurrentPullRequestStatus,
  DisablePullRequestAutoMergeOptions,
  EnablePullRequestAutoMergeOptions,
  ForgeReadOptions,
  ForgeService,
  GetCheckDetailsOptions,
  GetPullRequestOptions,
  GetPullRequestTimelineOptions,
  IssueSummary,
  ListIssuesOptions,
  ListPullRequestsOptions,
  MergePullRequestOptions,
  PullRequestChecksStatus,
  PullRequestCreateResult,
  PullRequestMergeable,
  PullRequestMergeResult,
  PullRequestSummary,
  PullRequestTimeline,
  PullRequestTimelineCommentLocation,
  PullRequestTimelineError,
  PullRequestTimelineErrorKind,
  PullRequestTimelineItem,
  PullRequestTimelineReviewState,
  PullRequestCheck,
  PullRequestCheckoutTarget,
  SearchIssuesAndPrsOptions,
  SearchResult,
} from "./forge-service.js";
import { isGiteaStatusFacts, type GiteaStatusFacts } from "./gitea-facts.js";

const TEA_ENV = {
  GIT_TERMINAL_PROMPT: "0",
} as const;

const TEA_COMMAND_TIMEOUT_MS = 30_000;
// The timeline's per-review comment fan-out spawns one `tea api` process per
// review that has comments; an unbounded Promise.allSettled over a PR with
// dozens of reviews would launch that many processes at once.
const REVIEW_COMMENTS_FAN_OUT_CONCURRENCY = 5;
const reviewCommentsLimit = pLimit(REVIEW_COMMENTS_FAN_OUT_CONCURRENCY);
// The client polls getCheckDetails every ~15s while a pipeline runs; without a
// short cache, each poll re-derives the PR head SHA from scratch (branch name +
// PR lookup + PR view). The TTL keeps a new push visible within one poll cycle.
const CURRENT_PR_HEAD_SHA_CACHE_TTL_MS = 30_000;
// 50 is the page-size cap Gitea enforces on list endpoints; five pages bounds
// the sweep to the 250 most recent Actions tasks.
const GITEA_ACTIONS_RUNS_PAGE_LIMIT = 50;
const GITEA_ACTIONS_RUNS_MAX_PAGES = 5;

/**
 * Fields requested from `tea pr list -o json`. tea's default field set omits the
 * ones the neutral mapping needs (url, mergeable, base, head, ci, body), so they
 * must be requested explicitly — otherwise tea silently emits the short default
 * set and the mapping loses data.
 */
const PR_LIST_FIELDS =
  "index,state,author,url,title,body,mergeable,base,head,created,updated,labels,comments,ci";

const ISSUE_LIST_FIELDS = "index,state,author,url,title,body,labels,comments,created,updated";

const CURRENT_PR_LOOKUP_PAGE_SIZE = 50;
const CURRENT_PR_OPEN_LOOKUP_MAX_PAGES = 4;
const TIMELINE_PAGE_SIZE = 50;
const TIMELINE_MAX_PAGES_PER_BUCKET = 4;

export class TeaCliMissingError extends ForgeCliMissingError {
  constructor() {
    super("Gitea CLI (tea) is not installed or not in PATH");
    this.name = "TeaCliMissingError";
  }
}

export class TeaAuthenticationError extends ForgeAuthenticationError {
  constructor(params: { stderr: string }) {
    super("Gitea CLI authentication failed", params);
    this.name = "TeaAuthenticationError";
  }
}

export class TeaCommandError extends ForgeCommandError {
  constructor(params: ForgeCommandFailureParams) {
    super({ brand: "Gitea", binary: "tea" }, params);
    this.name = "TeaCommandError";
  }
}

export interface TeaCommandRunnerOptions {
  cwd: string;
  envOverlay?: Record<string, string>;
}

export interface TeaCommandResult {
  stdout: string;
  stderr: string;
}

export type TeaCommandRunner = (
  args: string[],
  options: TeaCommandRunnerOptions,
) => Promise<TeaCommandResult>;

export interface CreateGiteaServiceOptions {
  runner?: TeaCommandRunner;
  resolveTeaPath?: () => Promise<string | null>;
  resolveRemoteUrl?: (cwd: string) => Promise<string | null>;
  resolveCurrentBranch?: (cwd: string) => Promise<string | null>;
  now?: () => number;
}

/**
 * `tea pr list -o json` flattens every value to a string (e.g. `index:"5"`,
 * `mergeable:"false"`, `comments:"0"`), unlike the single-PR view which is
 * natively typed. The list schema therefore parses strings and the mapping
 * coerces; `.passthrough()` tolerates the extra fields tea always includes.
 */
const GiteaPrListItemSchema = z
  .object({
    index: z.string(),
    state: z.string(),
    url: z.string(),
    title: z.string(),
    body: z.string().optional().default(""),
    mergeable: z.string().optional(),
    base: z.string().optional(),
    head: z.string().optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    labels: z.string().optional(),
    ci: z.string().optional(),
  })
  .passthrough();

const GiteaIssueListItemSchema = z
  .object({
    index: z.string(),
    state: z.string(),
    url: z.string(),
    title: z.string(),
    body: z.string().optional().default(""),
    labels: z.string().optional(),
    updated: z.string().optional(),
  })
  .passthrough();

const GiteaLoginSchema = z
  .object({
    name: z.string().optional(),
    url: z.string().optional(),
    ssh_host: z.string().optional(),
  })
  .passthrough();

const GiteaUserSchema = z
  .object({
    login: z.string().optional(),
    full_name: z.string().optional(),
    avatar_url: z.string().nullable().optional(),
    html_url: z.string().nullable().optional(),
  })
  .passthrough();

const GiteaPullRequestViewSchema = z
  .object({
    index: z.number(),
    url: z.string(),
    headSha: z.string().optional(),
    title: z.string().optional().default(""),
    state: z.string().optional().default("open"),
    body: z.string().nullable().optional(),
    base: z.string().optional(),
    head: z.string().optional(),
    mergeable: z.boolean().optional(),
    hasMerged: z.boolean().optional(),
    updated: z.string().optional(),
    // tea emits labels as an array of label objects (or strings on older builds);
    // tolerate both and extract the display name.
    labels: z.array(z.union([z.string(), z.object({ name: z.string() }).passthrough()])).optional(),
  })
  .passthrough();

/**
 * Subset of the Gitea/Forgejo REST PR object (`GET repos/{owner}/{repo}/pulls/{index}`)
 * that `tea pr -o json` flattens away: the head/base repositories. Comparing their
 * ids tells a fork PR (cross-repo) from a same-repo PR, and the head repo carries
 * the contributor remote we push back to. `head.repo` is null when the fork was
 * deleted, which we treat as same-repo.
 */
const GiteaPullRequestRepoSchema = z
  .object({
    id: z.number().optional(),
    ssh_url: z.string().nullable().optional(),
    html_url: z.string().nullable().optional(),
    owner: z.object({ login: z.string().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();

const GiteaPullRequestApiSchema = z
  .object({
    head: z
      .object({ repo: GiteaPullRequestRepoSchema.nullable().optional() })
      .passthrough()
      .optional(),
    base: z
      .object({ repo: GiteaPullRequestRepoSchema.nullable().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const GiteaCurrentPullRequestApiSchema = z
  .object({
    number: z.number(),
    html_url: z.string(),
    title: z.string(),
    body: z.string().nullable().optional(),
    state: z.string(),
    merged: z.boolean().optional(),
    mergeable: z.boolean().nullable().optional(),
    updated_at: z.string().optional(),
    labels: z
      .array(z.object({ name: z.string() }).passthrough())
      .optional()
      .default([]),
    head: z
      .object({
        ref: z.string(),
        sha: z.string(),
        repo: GiteaPullRequestRepoSchema.nullable().optional(),
      })
      .passthrough(),
    base: z
      .object({
        ref: z.string(),
        repo: GiteaPullRequestRepoSchema.nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const GiteaCommitStatusSchema = z
  .object({
    id: z.number(),
    status: z.string(),
    target_url: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    context: z.string().optional().default(""),
  })
  .passthrough();

const GiteaCombinedCommitStatusSchema = z
  .object({
    state: z.string().optional().default(""),
    sha: z.string().optional(),
    total_count: z.number().optional(),
    statuses: z.array(GiteaCommitStatusSchema).optional().default([]),
  })
  .passthrough();

const GiteaActionsRunSchema = z
  .object({
    id: z.number(),
    name: z.string().nullable().optional(),
    head_branch: z.string().nullable().optional(),
    head_sha: z.string(),
    run_number: z.number().optional(),
    event: z.string().nullable().optional(),
    display_title: z.string().nullable().optional(),
    status: z.string(),
    workflow_id: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    run_started_at: z.string().nullable().optional(),
  })
  .passthrough();

// The item shape is validated per-run rather than as `z.array(GiteaActionsRunSchema)`
// so one malformed run (missing id/status/head_sha) drops only itself instead of
// throwing out the whole page and zeroing every Actions check for the PR.
const GiteaActionsRunsSchema = z
  .object({
    workflow_runs: z.array(z.unknown()).optional().default([]),
    total_count: z.number().optional(),
  })
  .passthrough();

const GiteaIssueCommentSchema = z
  .object({
    id: z.number(),
    html_url: z.string().optional(),
    user: GiteaUserSchema.nullable().optional(),
    body: z.string().optional().default(""),
    created_at: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

const GiteaReviewSchema = z
  .object({
    id: z.number(),
    user: GiteaUserSchema.nullable().optional(),
    state: z.string(),
    body: z.string().optional().default(""),
    comments_count: z.number().optional().default(0),
    submitted_at: z.string().optional(),
    updated_at: z.string().optional(),
    html_url: z.string().optional(),
  })
  .passthrough();

const GiteaReviewCommentSchema = z
  .object({
    id: z.number(),
    body: z.string().optional().default(""),
    user: GiteaUserSchema.nullable().optional(),
    pull_request_review_id: z.number().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    path: z.string().optional(),
    position: z.number().optional(),
    original_position: z.number().optional(),
    resolver: GiteaUserSchema.nullable().optional(),
    html_url: z.string().optional(),
  })
  .passthrough();

type GiteaPrListItem = z.infer<typeof GiteaPrListItemSchema>;
type GiteaIssueListItem = z.infer<typeof GiteaIssueListItemSchema>;
type GiteaPullRequestView = z.infer<typeof GiteaPullRequestViewSchema>;
type GiteaCurrentPullRequestApi = z.infer<typeof GiteaCurrentPullRequestApiSchema>;
type GiteaCommitStatus = z.infer<typeof GiteaCommitStatusSchema>;
type GiteaCombinedCommitStatus = z.infer<typeof GiteaCombinedCommitStatusSchema>;
type GiteaActionsRun = z.infer<typeof GiteaActionsRunSchema>;
type GiteaIssueComment = z.infer<typeof GiteaIssueCommentSchema>;
type GiteaReview = z.infer<typeof GiteaReviewSchema>;
type GiteaReviewComment = z.infer<typeof GiteaReviewCommentSchema>;

interface GiteaTimelineBucket<T> {
  items: T[];
  truncated: boolean;
}

async function resolveTeaPath(): Promise<string | null> {
  return findExecutable("tea");
}

const teaCliRunner = createForgeCliRunner({
  binary: "tea",
  envOverlay: TEA_ENV,
  timeoutMs: TEA_COMMAND_TIMEOUT_MS,
  isAuthFailureText,
  errorClasses: {
    isAlreadyClassified: (candidate) =>
      candidate instanceof TeaAuthenticationError || candidate instanceof TeaCliMissingError,
    isCommandError: (candidate): candidate is TeaCommandError =>
      candidate instanceof TeaCommandError,
    createAuthError: (stderr) => new TeaAuthenticationError({ stderr }),
    createMissingError: () => new TeaCliMissingError(),
    createCommandError: (params) => new TeaCommandError(params),
  },
});

async function runTeaCommand(
  args: string[],
  options: TeaCommandRunnerOptions,
): Promise<TeaCommandResult> {
  return teaCliRunner.run(args, options);
}

async function defaultResolveCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["branch", "--show-current"], { cwd });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

export function parseGiteaHostFromRemoteUrl(url: string): string | null {
  return parseGitRemoteLocation(url)?.host ?? null;
}

/**
 * tea numeric fields arrive as strings in list output. Returns null for a
 * missing/non-numeric value so callers can decide on a fallback.
 */
function parseGiteaInt(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseGiteaBool(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function timelineApiPath(input: GetPullRequestTimelineOptions, suffix: string): string {
  const owner = encodeURIComponent(input.repoOwner);
  const repo = encodeURIComponent(input.repoName);
  return `repos/${owner}/${repo}/${suffix}`;
}

function timelinePageQuery(page: number): string {
  return `page=${page}&limit=${TIMELINE_PAGE_SIZE}`;
}

function giteaUserLogin(user: z.infer<typeof GiteaUserSchema> | null | undefined): string {
  return user?.login ?? user?.full_name ?? "unknown";
}

function giteaUserUrl(user: z.infer<typeof GiteaUserSchema> | null | undefined): string | null {
  return user?.html_url ?? null;
}

function giteaUserAvatar(user: z.infer<typeof GiteaUserSchema> | null | undefined): string | null {
  return user?.avatar_url ?? null;
}

function isGiteaSystemComment(comment: GiteaIssueComment): boolean {
  return comment.type !== undefined && comment.type !== "comment";
}

function toGiteaReviewState(state: string): PullRequestTimelineReviewState {
  switch (state.trim().toUpperCase()) {
    case "APPROVED":
    case "APPROVE":
      return "approved";
    case "REQUEST_CHANGES":
    case "REQUESTED_CHANGES":
    case "CHANGES_REQUESTED":
      return "changes_requested";
    default:
      return "commented";
  }
}

function toGiteaTimelineComment(
  comment: GiteaIssueComment,
  pr: GiteaPullRequestView,
): PullRequestTimelineItem | null {
  if (isGiteaSystemComment(comment)) {
    return null;
  }
  return {
    kind: "comment",
    id: String(comment.id),
    author: giteaUserLogin(comment.user),
    authorUrl: giteaUserUrl(comment.user),
    avatarUrl: giteaUserAvatar(comment.user),
    body: comment.body,
    createdAt: parseOptionalTime(comment.created_at),
    url: comment.html_url ?? `${pr.url}#issuecomment-${comment.id}`,
  };
}

function toGiteaTimelineReview(review: GiteaReview): PullRequestTimelineItem {
  return {
    kind: "review",
    id: String(review.id),
    author: giteaUserLogin(review.user),
    authorUrl: giteaUserUrl(review.user),
    avatarUrl: giteaUserAvatar(review.user),
    body: review.body,
    createdAt: parseOptionalTime(review.submitted_at ?? review.updated_at),
    url: review.html_url ?? "",
    reviewState: toGiteaReviewState(review.state),
  };
}

/**
 * Gitea/Forgejo expose no stable review-thread id, so distinct inline locations
 * within one review all share a single `pull_request_review_id`. Keying threads
 * on that id collapses unrelated file/line comments into one card. Instead key
 * on the diff position (path + position), which a reply to the same inline
 * thread reuses, so distinct locations stay separate while same-location replies
 * still group, matching GitHub's review-thread grouping as closely as the API
 * allows. Without a diff position (comment scrolled out of the current diff),
 * fall back to the comment's own id so unrelated comments never merge.
 */
function giteaReviewCommentThreadId(comment: GiteaReviewComment): string {
  const position = comment.position ?? comment.original_position ?? null;
  const anchor = position != null ? `pos-${position}` : `comment-${comment.id}`;
  return `${comment.path}#${anchor}`;
}

/**
 * Gitea/Forgejo set `resolver` to the user who resolved an inline review thread,
 * or null when it is still open. Older servers omit the field entirely; treat
 * absence as "unknown" and leave `isResolved` off rather than guessing unresolved.
 */
function giteaReviewCommentResolved(comment: GiteaReviewComment): boolean | undefined {
  if (!("resolver" in comment)) {
    return undefined;
  }
  return comment.resolver != null;
}

function toGiteaReviewCommentLocation(
  comment: GiteaReviewComment,
): PullRequestTimelineCommentLocation | undefined {
  if (!comment.path) {
    return undefined;
  }
  const isResolved = giteaReviewCommentResolved(comment);
  return {
    path: comment.path,
    ...(comment.position != null ? { line: comment.position } : {}),
    threadId: giteaReviewCommentThreadId(comment),
    ...(isResolved !== undefined ? { isResolved } : {}),
  };
}

function toGiteaTimelineReviewComment(comment: GiteaReviewComment): PullRequestTimelineItem {
  const location = toGiteaReviewCommentLocation(comment);
  return {
    kind: "comment",
    id: String(comment.id),
    author: giteaUserLogin(comment.user),
    authorUrl: giteaUserUrl(comment.user),
    avatarUrl: giteaUserAvatar(comment.user),
    body: comment.body,
    createdAt: parseOptionalTime(comment.created_at ?? comment.updated_at),
    url: comment.html_url ?? "",
    ...(comment.pull_request_review_id != null
      ? { reviewId: String(comment.pull_request_review_id) }
      : {}),
    ...(location ? { location } : {}),
  };
}

function splitGiteaLabels(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

/**
 * tea reports a PR head as `owner:branch` for cross-repo PRs and a bare branch
 * for same-repo ones. The neutral head ref is always just the branch name.
 */
function stripHeadOwner(head: string | undefined): string {
  if (!head) {
    return "";
  }
  const colon = head.indexOf(":");
  return colon >= 0 ? head.slice(colon + 1) : head;
}

function headHasOwner(head: string | undefined): boolean {
  return head !== undefined && head.indexOf(":") >= 0;
}

/**
 * The head repo owner for a PR list item: the `owner:` prefix for a cross-repo
 * (fork) head, otherwise the base repo owner parsed from the item URL, since a
 * same-repo head arrives as a bare branch. Returns null when neither is known.
 */
function giteaHeadOwner(item: GiteaPrListItem): string | null {
  const head = item.head;
  if (head) {
    const colon = head.indexOf(":");
    if (colon >= 0) {
      return head.slice(0, colon);
    }
  }
  return parseGiteaRepoFromUrl(item.url).owner ?? null;
}

/**
 * Match a PR list item to the checkout's current head. Two open PRs from
 * different forks can share a branch name (`alice:fix` vs `bob:fix`), so the
 * branch alone is ambiguous. When the checkout's head owner is known, require
 * the head repo owner to match it too; when it cannot be determined, accept only
 * a same-repo (bare) head so a colliding cross-fork PR is never picked blindly.
 */
function matchesCurrentHeadRef(
  item: GiteaPrListItem,
  headRef: string,
  expectedHeadOwner: string | null,
): boolean {
  if (stripHeadOwner(item.head) !== headRef) {
    return false;
  }
  if (expectedHeadOwner === null) {
    return !headHasOwner(item.head);
  }
  return giteaHeadOwner(item) === expectedHeadOwner;
}

function mapGiteaState(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized === "open") {
    return "open";
  }
  if (normalized === "merged") {
    return "merged";
  }
  return "closed";
}

function mapGiteaMergeable(item: GiteaPrListItem): PullRequestMergeable {
  if (item.mergeable === undefined) {
    return "UNKNOWN";
  }
  return parseGiteaBool(item.mergeable) ? "MERGEABLE" : "CONFLICTING";
}

function mapGiteaCiStatus(ci: string | undefined): PullRequestChecksStatus {
  switch (ci?.toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "error":
    // Gitea's "warning" is a terminal, NON-passing state: IsSuccess() is false,
    // it fails required-status checks, and Gitea itself blocks the merge on it.
    // Our neutral enum has no yellow/neutral bucket, so surface it as failure —
    // never success (misleading green) or pending (never-resolving poll).
    case "warning":
      return "failure";
    case "pending":
    case "running":
      return "pending";
    default:
      return "none";
  }
}

function mapGiteaCommitStatus(state: string): PullRequestCheck["status"] {
  switch (state.toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "error":
    // See mapGiteaCiStatus: "warning" is terminal and non-passing (blocks merge).
    case "warning":
      return "failure";
    case "pending":
      return "pending";
    default:
      return "pending";
  }
}

function mapGiteaActionsRunStatus(status: string): PullRequestCheck["status"] {
  switch (status.toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "failed":
    case "error":
      return "failure";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "pending":
    case "queued":
    case "waiting":
    case "requested":
    case "running":
    case "in_progress":
    case "blocked":
      return "pending";
    default:
      return "pending";
  }
}

function toGiteaPullRequestCheck(status: GiteaCommitStatus): PullRequestCheck {
  return {
    name: status.context || `status-${status.id}`,
    status: mapGiteaCommitStatus(status.status),
    url: status.target_url ?? null,
    checkRunId: status.id,
  };
}

function getGiteaActionsRunName(workflowRun: GiteaActionsRun): string {
  return (
    workflowRun.name ||
    workflowRun.display_title ||
    workflowRun.workflow_id ||
    `actions-${workflowRun.id}`
  );
}

function toGiteaActionsPullRequestCheck(workflowRun: GiteaActionsRun): PullRequestCheck {
  return {
    name: getGiteaActionsRunName(workflowRun),
    status: mapGiteaActionsRunStatus(workflowRun.status),
    url: workflowRun.url ?? null,
    workflowRunId: workflowRun.id,
  };
}

function getGiteaActionsWorkflowIdentity(workflowRun: GiteaActionsRun): string {
  return workflowRun.workflow_id || workflowRun.name || `actions-${workflowRun.id}`;
}

function parseGiteaActionsRunTime(workflowRun: GiteaActionsRun): number {
  const timestamp = workflowRun.created_at ?? workflowRun.run_started_at ?? null;
  if (!timestamp) {
    return 0;
  }
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? 0 : time;
}

function compareGiteaActionsRunRecency(left: GiteaActionsRun, right: GiteaActionsRun): number {
  const leftRunNumber = left.run_number ?? 0;
  const rightRunNumber = right.run_number ?? 0;
  if (leftRunNumber !== rightRunNumber) {
    return leftRunNumber - rightRunNumber;
  }

  const leftTime = parseGiteaActionsRunTime(left);
  const rightTime = parseGiteaActionsRunTime(right);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.id - right.id;
}

function parseGiteaActionsRuns(rawRuns: unknown[]): GiteaActionsRun[] {
  const runs: GiteaActionsRun[] = [];
  for (const raw of rawRuns) {
    const parsed = GiteaActionsRunSchema.safeParse(raw);
    if (parsed.success) {
      runs.push(parsed.data);
    }
  }
  return runs;
}

function latestGiteaActionsRunsByWorkflow(actionsRuns: GiteaActionsRun[]): GiteaActionsRun[] {
  const latestRuns = new Map<string, GiteaActionsRun>();
  for (const workflowRun of actionsRuns) {
    const identity = getGiteaActionsWorkflowIdentity(workflowRun);
    const current = latestRuns.get(identity);
    if (!current || compareGiteaActionsRunRecency(current, workflowRun) < 0) {
      latestRuns.set(identity, workflowRun);
    }
  }
  return [...latestRuns.values()];
}

function combineGiteaChecks(
  commitStatuses: GiteaCommitStatus[],
  actionsRuns: GiteaActionsRun[],
): PullRequestCheck[] {
  const checks = commitStatuses.map(toGiteaPullRequestCheck);
  const seen = new Set(
    checks.map((check) => `${check.name}\u0000${check.url ?? ""}\u0000${check.status}`),
  );
  for (const workflowRun of actionsRuns) {
    const check = toGiteaActionsPullRequestCheck(workflowRun);
    const key = `${check.name}\u0000${check.url ?? ""}\u0000${check.status}`;
    if (!seen.has(key)) {
      checks.push(check);
      seen.add(key);
    }
  }
  return checks;
}

function applyGiteaChecks(
  status: CurrentPullRequestStatus,
  combined: GiteaCombinedCommitStatus,
  actionsRuns: GiteaActionsRun[],
): CurrentPullRequestStatus {
  const checks = combineGiteaChecks(combined.statuses, actionsRuns);
  if (checks.length === 0) {
    return status;
  }
  // Aggregate over the union of commit statuses AND Actions runs. Gitea's
  // combined.state summarizes commit statuses only, so trusting it would let a
  // failing/pending Actions run be reported as success. computeChecksStatus
  // applies failure > pending > success precedence across every check.
  return {
    ...status,
    checks,
    checksStatus: computeChecksStatus(checks),
  };
}

/** Parse owner/name from a Gitea PR/issue URL (`https://host/owner/repo/pulls/N`). */
function parseGiteaRepoFromUrl(url: string): { owner?: string; name?: string } {
  try {
    const segments = new URL(url).pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length >= 2) {
      return { owner: segments[0], name: segments[1] };
    }
  } catch {
    // fall through
  }
  return {};
}

function currentPullRequestApiToListItem(item: GiteaCurrentPullRequestApi): GiteaPrListItem {
  const headOwner = item.head.repo?.owner?.login;
  const baseOwner = item.base.repo?.owner?.login;
  const head =
    headOwner && headOwner !== baseOwner ? `${headOwner}:${item.head.ref}` : item.head.ref;
  return {
    index: String(item.number),
    state: item.merged ? "merged" : item.state,
    url: item.html_url,
    title: item.title,
    body: item.body ?? "",
    ...(item.mergeable != null ? { mergeable: String(item.mergeable) } : {}),
    base: item.base.ref,
    head,
    updated: item.updated_at,
    labels: item.labels.map((label) => label.name).join(","),
  };
}

function toPullRequestSummary(item: GiteaPrListItem): PullRequestSummary {
  const { owner, name } = parseGiteaRepoFromUrl(item.url);
  return {
    number: parseGiteaInt(item.index) ?? 0,
    title: item.title,
    url: item.url,
    state: mapGiteaState(item.state),
    body: item.body || null,
    ...(owner && name ? { projectPath: `${owner}/${name}` } : {}),
    baseRefName: item.base ?? "",
    headRefName: stripHeadOwner(item.head),
    labels: splitGiteaLabels(item.labels),
    updatedAt: item.updated ?? "",
  };
}

function viewToPullRequestSummary(view: GiteaPullRequestView): PullRequestSummary {
  const { owner, name } = parseGiteaRepoFromUrl(view.url);
  return {
    number: view.index,
    title: view.title,
    url: view.url,
    state: view.hasMerged ? "merged" : mapGiteaState(view.state),
    body: view.body || null,
    ...(owner && name ? { projectPath: `${owner}/${name}` } : {}),
    baseRefName: view.base ?? "",
    headRefName: stripHeadOwner(view.head),
    labels: (view.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)),
    updatedAt: view.updated ?? "",
  };
}

function toIssueSummary(item: GiteaIssueListItem): IssueSummary {
  const { owner, name } = parseGiteaRepoFromUrl(item.url);
  return {
    number: parseGiteaInt(item.index) ?? 0,
    title: item.title,
    url: item.url,
    state: mapGiteaState(item.state),
    body: item.body || null,
    ...(owner && name ? { projectPath: `${owner}/${name}` } : {}),
    labels: splitGiteaLabels(item.labels),
    updatedAt: item.updated ?? "",
  };
}

function toGiteaStatusFacts(item: GiteaPrListItem): GiteaStatusFacts {
  return {
    mergeable: parseGiteaBool(item.mergeable),
    hasMerged: mapGiteaState(item.state) === "merged",
    ciStatus: item.ci && item.ci.length > 0 ? item.ci : null,
  };
}

function toCurrentPullRequestStatus(item: GiteaPrListItem): CurrentPullRequestStatus {
  const { owner, name } = parseGiteaRepoFromUrl(item.url);
  const state = mapGiteaState(item.state);
  return {
    number: parseGiteaInt(item.index) ?? undefined,
    ...(owner ? { repoOwner: owner } : {}),
    ...(name ? { repoName: name } : {}),
    ...(owner && name ? { projectPath: `${owner}/${name}` } : {}),
    url: item.url,
    title: item.title,
    state,
    baseRefName: item.base ?? "",
    headRefName: stripHeadOwner(item.head),
    isMerged: state === "merged",
    mergeable: mapGiteaMergeable(item),
    checks: [],
    checksStatus: mapGiteaCiStatus(item.ci),
    reviewDecision: null,
    // The whole Gitea family (gitea, forgejo, codeberg) tags its facts with the
    // family id "gitea" — they share one facts shape and one guard. This is the
    // facts-family tag, distinct from the workspace's brand-specific forge id.
    forgeSpecific: { forge: "gitea", ...toGiteaStatusFacts(item) },
  };
}

/**
 * Server-side guard for a Gitea direct merge, mirroring the gh/glab adapters:
 * refuse the merge unless Gitea reports the PR as mergeable. The resolved status
 * can go stale between the client check and execution, and the RPC can be called
 * directly, so the guard lives here rather than only in the UI policy.
 */
function assertGiteaDirectMergeReady(input: Pick<MergePullRequestOptions, "status">): void {
  const facts = input.status?.forgeSpecific;
  if (!isGiteaStatusFacts(facts)) {
    throw new Error("Gitea merge facts are unavailable for this pull request");
  }
  if (facts.hasMerged) {
    throw new Error("This pull request is already merged");
  }
  if (!facts.mergeable) {
    throw new Error("Gitea does not report this pull request as ready for direct merge");
  }
}

function isAuthFailureText(text: string): boolean {
  return /\b(401|unauthorized|not logged in|authentication failed|no token|invalid token|no logins?)\b/i.test(
    text,
  );
}

function classifyGiteaTimelineErrorKind(stderr: string): PullRequestTimelineErrorKind {
  const normalized = stderr.toLowerCase();
  if (normalized.includes("404") || normalized.includes("not found")) {
    return "not_found";
  }
  if (normalized.includes("403") || normalized.includes("forbidden") || isAuthFailureText(stderr)) {
    return "forbidden";
  }
  return "unknown";
}

/**
 * Re-throw only tea auth / CLI-missing failures, letting every other error be
 * swallowed by a best-effort caller. Background status polling wraps its checks
 * load in its own catch, so this stays invisible there; on the explicit,
 * user-triggered check-details path it lets an expired token surface the real
 * remediation instead of a misleading "check not found".
 */
function rethrowTeaAuthFailure(error: unknown): void {
  if (error instanceof TeaAuthenticationError || error instanceof TeaCliMissingError) {
    throw error;
  }
}

function mapGiteaTimelineError(error: unknown): PullRequestTimelineError {
  if (error instanceof TeaAuthenticationError || error instanceof TeaCliMissingError) {
    return { kind: "forbidden", message: error.message };
  }
  if (error instanceof TeaCommandError) {
    return {
      kind: classifyGiteaTimelineErrorKind(error.stderr),
      message: error.stderr || error.message,
    };
  }
  return { kind: "unknown", message: error instanceof Error ? error.message : String(error) };
}

function extractPullRequestUrl(stdout: string): string | null {
  const match = stdout.match(/https?:\/\/\S+\/pulls\/\d+/);
  return match ? match[0] : null;
}

function parseIndexFromUrl(url: string): number | null {
  const match = url.match(/\/pulls\/(\d+)/);
  return match ? Number(match[1]) : null;
}

// Flags whose values carry user/generated content (a PR title or body may
// contain a secret). The value that follows any of these in argv is replaced
// before argv is embedded in a client-facing error.
const TEA_SENSITIVE_FLAGS = new Set(["--title", "--description", "--body"]);
const TEA_REDACTED_VALUE = "<redacted>";

/**
 * Redact the values of sensitive flags in a tea argv so a command failure that
 * surfaces to the remote/mobile client never echoes a PR title or body. The
 * real argv still runs; only the copy stored on the error is scrubbed.
 */
function redactTeaArgs(args: string[]): string[] {
  return args.map((arg, index) =>
    index > 0 && TEA_SENSITIVE_FLAGS.has(args[index - 1]) ? TEA_REDACTED_VALUE : arg,
  );
}

/**
 * Probe whether a host is a Gitea instance Paseo can talk to. tea has no
 * per-repo auth check (it keeps per-instance logins), so a configured tea login
 * for the host is the signal: it means tea both recognizes the host as Gitea and
 * holds a usable token for it. Mirrors the role of `glab auth status` for GitLab.
 */
export async function probeGiteaHost(host: string): Promise<boolean> {
  const teaPath = await findExecutable("tea");
  if (!teaPath) {
    return false;
  }
  try {
    const { stdout } = await execCommand("tea", ["login", "list", "-o", "json"], {
      envOverlay: TEA_ENV,
      timeout: CLI_AUTH_PROBE_TIMEOUT_MS,
    });
    return hostHasLogin(stdout, host);
  } catch {
    return false;
  }
}

function findTeaLoginNameForHost(stdout: string, host: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = z.array(GiteaLoginSchema).safeParse(data);
  if (!parsed.success) {
    return null;
  }
  const target = host.toLowerCase();
  const match = parsed.data.find((login) => {
    const candidates = [login.ssh_host, login.name];
    if (login.url) {
      try {
        candidates.push(new URL(login.url).hostname);
      } catch {
        // ignore malformed login url
      }
    }
    return candidates.some((candidate) => candidate?.toLowerCase() === target);
  });
  return match?.name ?? null;
}

function hostHasLogin(stdout: string, host: string): boolean {
  return findTeaLoginNameForHost(stdout, host) !== null;
}

export type GiteaFamilySoftware = "gitea" | "forgejo";

/**
 * The Forgejo REST namespace exists only on Forgejo; Gitea's router returns 404
 * for it. We check it only through authenticated tea so the resolver never makes
 * anonymous HTTP requests to a remote-derived host.
 */
const FORGEJO_VERSION_PATH = "/api/forgejo/v1/version";
const GITEA_SOFTWARE_PROBE_TIMEOUT_MS = 5_000;

type TeaApiRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface DetectGiteaFamilyOptions {
  /** Authenticated tier transport; defaults to spawning `tea`. */
  runTea?: TeaApiRunner;
}

async function defaultRunTea(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execCommand("tea", args, {
    envOverlay: TEA_ENV,
    timeout: GITEA_SOFTWARE_PROBE_TIMEOUT_MS,
  });
  return { stdout, stderr };
}

const HTTP_STATUS_LINE = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/m;

function parseHttpStatus(headerDump: string): number | null {
  const match = headerDump.match(HTTP_STATUS_LINE);
  return match ? Number(match[1]) : null;
}

/**
 * Probe the Forgejo namespace through an authenticated `tea` request. `tea api`
 * exits 0 regardless of HTTP status, so the verdict is read from the status line
 * `tea api -i` emits. Different tea builds print that line on stdout or stderr,
 * so both streams are parsed. When `-i` is unsupported no status line appears
 * (or the call errors) and the probe is inconclusive (null), leaving the Gitea
 * default in place — the branch is always non-fatal.
 *
 * Not verified against a live self-hosted Forgejo instance; QA follow-up.
 */
async function probeForgejoNamespaceByTea(
  host: string,
  runTea: TeaApiRunner,
): Promise<boolean | null> {
  let loginName: string | null;
  try {
    const { stdout } = await runTea(["login", "list", "-o", "json"]);
    loginName = findTeaLoginNameForHost(stdout, host);
  } catch {
    return null;
  }
  if (!loginName) {
    return null;
  }
  try {
    const { stdout, stderr } = await runTea([
      "api",
      "--login",
      loginName,
      "-i",
      FORGEJO_VERSION_PATH,
    ]);
    const status = parseHttpStatus(stderr) ?? parseHttpStatus(stdout);
    if (status === 404) {
      return false;
    }
    if (status !== null && status >= 200 && status < 300) {
      return true;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a Gitea-family host runs Forgejo or Gitea through authenticated
 * tea only. Inconclusive detection keeps the historical Gitea default.
 */
export async function detectGiteaFamilySoftware(
  host: string,
  options: DetectGiteaFamilyOptions = {},
): Promise<GiteaFamilySoftware> {
  const runTea = options.runTea ?? defaultRunTea;

  const viaTea = await probeForgejoNamespaceByTea(host, runTea);
  if (viaTea !== null) {
    return viaTea ? "forgejo" : "gitea";
  }
  return "gitea";
}

const inFlightFamilyProbes = new Map<string, Promise<GiteaFamilySoftware | null>>();

/**
 * Resolve which Gitea-family forge id a host maps to for the open registry:
 * null when there is no usable `tea` login (Paseo cannot operate the host),
 * otherwise the detected software. Concurrent calls for the same host — the
 * gitea and forgejo registrations probing in parallel — share one probe so
 * detection runs once.
 */
export function resolveGiteaFamilyForge(host: string): Promise<GiteaFamilySoftware | null> {
  const existing = inFlightFamilyProbes.get(host);
  if (existing) {
    return existing;
  }
  const pending = (async () => {
    if (!(await probeGiteaHost(host))) {
      return null;
    }
    return detectGiteaFamilySoftware(host);
  })().finally(() => {
    inFlightFamilyProbes.delete(host);
  });
  inFlightFamilyProbes.set(host, pending);
  return pending;
}

function isTeaSearchAuthFailure(reason: unknown): boolean {
  return reason instanceof TeaCliMissingError || reason instanceof TeaAuthenticationError;
}

function getTeaUnavailableSearchAuthState(
  results: PromiseSettledResult<unknown>[],
): "cli_missing" | "unauthenticated" | null {
  if (
    results.length === 0 ||
    !results.every(
      (result) => result.status === "rejected" && isTeaSearchAuthFailure(result.reason),
    )
  ) {
    return null;
  }
  return results.some(
    (result) => result.status === "rejected" && result.reason instanceof TeaCliMissingError,
  )
    ? "cli_missing"
    : "unauthenticated";
}

function throwFirstNonTeaAuthSearchRejection(results: PromiseSettledResult<unknown>[]): void {
  const failed = results.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected" && !isTeaSearchAuthFailure(result.reason),
  );
  if (failed) {
    throw failed.reason;
  }
}

export function createGiteaService(options: CreateGiteaServiceOptions = {}): ForgeService {
  const runner = options.runner ?? runTeaCommand;
  const resolveTea = createCachedCliPathResolver(options.resolveTeaPath ?? resolveTeaPath);
  const resolveRemoteUrl = options.resolveRemoteUrl ?? defaultResolveRemoteUrl;
  const resolveCurrentBranch = options.resolveCurrentBranch ?? defaultResolveCurrentBranch;
  const now = options.now ?? Date.now;
  const currentPrHeadShaCache = new Map<string, { sha: string; expiresAt: number }>();

  async function run(args: string[], runOptions: TeaCommandRunnerOptions): Promise<string> {
    const teaPath = await resolveTea();
    if (!teaPath) {
      throw new TeaCliMissingError();
    }
    try {
      const result = await runner(args, runOptions);
      return result.stdout.trim();
    } catch (error) {
      throw teaCliRunner.normalizeError(error, { args: redactTeaArgs(args), cwd: runOptions.cwd });
    }
  }

  function runJsonParse<T>(
    args: string[],
    runOptions: TeaCommandRunnerOptions,
    stdout: string,
    schema: z.ZodType<T>,
  ): T {
    return parseCliJsonOutput({
      commandName: "tea",
      args,
      cwd: runOptions.cwd,
      stdout,
      schema,
      createCommandError: (params) => new TeaCommandError(params),
    });
  }

  async function runJsonArray<T>(
    args: string[],
    runOptions: TeaCommandRunnerOptions,
    itemSchema: z.ZodType<T>,
  ): Promise<T[]> {
    const stdout = await run(args, runOptions);
    if (!stdout) {
      return [];
    }
    return runJsonParse(args, runOptions, stdout, z.array(itemSchema));
  }

  async function runJson<T>(
    args: string[],
    runOptions: TeaCommandRunnerOptions,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const stdout = await run(args, runOptions);
    return runJsonParse(args, runOptions, stdout, schema);
  }

  async function resolveForkCheckoutFacts(
    cwd: string,
    summary: PullRequestSummary,
  ): Promise<{
    isCrossRepository: boolean;
    headOwnerLogin: string | null;
    headRepositorySshUrl: string | null;
    headRepositoryUrl: string | null;
  }> {
    const sameRepo = {
      isCrossRepository: false,
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
    };
    const { owner, name } = parseGiteaRepoFromUrl(summary.url);
    if (!owner || !name) {
      return sameRepo;
    }
    const pr = await runJson(
      [
        "api",
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${summary.number}`,
      ],
      { cwd },
      GiteaPullRequestApiSchema,
    );
    const headRepo = pr.head?.repo ?? null;
    const baseRepo = pr.base?.repo ?? null;
    if (headRepo?.id == null || baseRepo?.id == null || headRepo.id === baseRepo.id) {
      return sameRepo;
    }
    return {
      isCrossRepository: true,
      headOwnerLogin: headRepo.owner?.login ?? null,
      headRepositorySshUrl: headRepo.ssh_url ?? null,
      headRepositoryUrl: headRepo.html_url ?? null,
    };
  }

  async function listPullRequestItems(input: {
    cwd: string;
    state: "open" | "closed" | "all";
    query?: string;
    limit?: number;
    page?: number;
  }): Promise<GiteaPrListItem[]> {
    const args = ["pr", "list", "--fields", PR_LIST_FIELDS, "--state", input.state, "-o", "json"];
    if (typeof input.limit === "number") {
      args.push("--limit", String(input.limit));
    }
    if (typeof input.page === "number") {
      args.push("--page", String(input.page));
    }
    const items = await runJsonArray(args, { cwd: input.cwd }, GiteaPrListItemSchema);
    const query = input.query?.trim().toLowerCase();
    if (!query) {
      return items;
    }
    return items.filter((item) => item.title.toLowerCase().includes(query));
  }

  async function runIssueList(input: {
    cwd: string;
    query?: string;
    limit?: number;
  }): Promise<IssueSummary[]> {
    const args = ["issue", "list", "--fields", ISSUE_LIST_FIELDS, "--state", "open", "-o", "json"];
    if (typeof input.limit === "number") {
      args.push("--limit", String(input.limit));
    }
    const items = await runJsonArray(args, { cwd: input.cwd }, GiteaIssueListItemSchema);
    const query = input.query?.trim().toLowerCase();
    const filtered = query
      ? items.filter((item) => item.title.toLowerCase().includes(query))
      : items;
    return filtered.map(toIssueSummary);
  }

  async function listPullRequestReviewComments(input: {
    cwd: string;
    repoOwner: string;
    repoName: string;
    prNumber: number;
    reviewId: number;
  }): Promise<GiteaTimelineBucket<GiteaReviewComment>> {
    return listTimelineBucketPages(
      input,
      `pulls/${input.prNumber}/reviews/${input.reviewId}/comments`,
      GiteaReviewCommentSchema,
    );
  }

  async function listTimelineBucketPages<T>(
    input: GetPullRequestTimelineOptions,
    suffix: string,
    itemSchema: z.ZodType<T>,
  ): Promise<GiteaTimelineBucket<T>> {
    const items: T[] = [];
    for (let page = 1; page <= TIMELINE_MAX_PAGES_PER_BUCKET; page += 1) {
      const pageItems = await runJsonArray(
        ["api", timelineApiPath(input, `${suffix}?${timelinePageQuery(page)}`)],
        { cwd: input.cwd },
        itemSchema,
      );
      items.push(...pageItems);
      if (pageItems.length < TIMELINE_PAGE_SIZE) {
        return { items, truncated: false };
      }
    }
    return { items, truncated: true };
  }

  async function loadCurrentPullRequestStatus(input: {
    cwd: string;
    headRef: string;
    headSha?: string;
  }): Promise<CurrentPullRequestStatus | null> {
    const match = await findCurrentPullRequestForHeadRef(input);
    if (!match) {
      return null;
    }
    const status = toCurrentPullRequestStatus(match);
    return loadCurrentPullRequestChecks(input.cwd, match, status);
  }

  async function resolveCurrentRepoIdentity(
    cwd: string,
  ): Promise<{ owner: string; name: string } | null> {
    const remoteUrl = await resolveRemoteUrl(cwd);
    if (!remoteUrl) {
      return null;
    }
    const location = parseGitRemoteLocation(remoteUrl);
    if (!location) {
      return null;
    }
    const identity = parseGitHubRemoteIdentity(location.path);
    return identity ? { owner: identity.owner, name: identity.name } : null;
  }

  async function findCurrentPullRequestForHeadRef(input: {
    cwd: string;
    headRef: string;
    headSha?: string;
  }): Promise<GiteaPrListItem | null> {
    const repoIdentity = await resolveCurrentRepoIdentity(input.cwd);
    const expectedHeadOwner = repoIdentity?.owner ?? null;
    const openMatch = await findOpenPullRequestForHeadRef(input, expectedHeadOwner);
    if (openMatch) {
      return openMatch;
    }

    // tea discovers repository context from any configured git remote, while
    // the default remote resolver reads origin only. Preserve that broader
    // discovery for repositories whose primary remote has another name.
    const repoPath = repoIdentity
      ? `repos/${encodeURIComponent(repoIdentity.owner)}/${encodeURIComponent(repoIdentity.name)}`
      : "repos/{owner}/{repo}";
    const recentItems = await runJsonArray(
      [
        "api",
        `${repoPath}/pulls?state=all&sort=recentupdate&page=1&limit=${CURRENT_PR_LOOKUP_PAGE_SIZE}`,
      ],
      { cwd: input.cwd },
      GiteaCurrentPullRequestApiSchema,
    );
    const candidates = recentItems.filter((item) =>
      matchesCurrentHeadRef(
        currentPullRequestApiToListItem(item),
        input.headRef,
        expectedHeadOwner,
      ),
    );
    const match =
      candidates.find((item) => mapGiteaState(item.state) === "open") ??
      candidates.find(
        (item) =>
          mapGiteaState(item.state) !== "open" &&
          input.headSha !== undefined &&
          item.head.sha === input.headSha,
      ) ??
      null;
    return match ? currentPullRequestApiToListItem(match) : null;
  }

  async function findOpenPullRequestForHeadRef(
    input: {
      cwd: string;
      headRef: string;
      headSha?: string;
    },
    expectedHeadOwner: string | null,
  ): Promise<GiteaPrListItem | null> {
    for (let page = 1; page <= CURRENT_PR_OPEN_LOOKUP_MAX_PAGES; page += 1) {
      const items = await listPullRequestItems({
        cwd: input.cwd,
        state: "open",
        limit: CURRENT_PR_LOOKUP_PAGE_SIZE,
        page,
      });
      const match = items.find((item) =>
        matchesCurrentHeadRef(item, input.headRef, expectedHeadOwner),
      );
      if (match) {
        return match;
      }
      if (items.length < CURRENT_PR_LOOKUP_PAGE_SIZE) {
        return null;
      }
    }
    return null;
  }

  async function loadCurrentPullRequestChecks(
    cwd: string,
    item: GiteaPrListItem,
    status: CurrentPullRequestStatus,
  ): Promise<CurrentPullRequestStatus> {
    const number = parseGiteaInt(item.index);
    if (number === null || !status.repoOwner || !status.repoName) {
      return status;
    }
    try {
      const pr = await runJson(
        ["pr", String(number), "-o", "json"],
        { cwd },
        GiteaPullRequestViewSchema,
      );
      if (!pr.headSha) {
        return status;
      }
      const [combined, actionsRuns] = await Promise.all([
        loadCombinedCommitStatusBestEffort({
          cwd,
          repoOwner: status.repoOwner,
          repoName: status.repoName,
          sha: pr.headSha,
        }),
        loadActionsRunsBestEffort({
          cwd,
          repoOwner: status.repoOwner,
          repoName: status.repoName,
          sha: pr.headSha,
        }),
      ]);
      return applyGiteaChecks(status, combined, actionsRuns);
    } catch {
      return status;
    }
  }

  async function loadCombinedCommitStatusBestEffort(input: {
    cwd: string;
    repoOwner: string;
    repoName: string;
    sha: string;
  }): Promise<GiteaCombinedCommitStatus> {
    try {
      return await loadCombinedCommitStatus(input);
    } catch (error) {
      rethrowTeaAuthFailure(error);
      return { state: "", statuses: [], total_count: 0 };
    }
  }

  async function loadCombinedCommitStatus(input: {
    cwd: string;
    repoOwner: string;
    repoName: string;
    sha: string;
  }): Promise<GiteaCombinedCommitStatus> {
    const owner = encodeURIComponent(input.repoOwner);
    const repo = encodeURIComponent(input.repoName);
    const sha = encodeURIComponent(input.sha);
    return runJson(
      ["api", `repos/${owner}/${repo}/commits/${sha}/status`],
      { cwd: input.cwd },
      GiteaCombinedCommitStatusSchema,
    );
  }

  async function loadActionsRunsBestEffort(input: {
    cwd: string;
    repoOwner: string;
    repoName: string;
    sha: string;
  }): Promise<GiteaActionsRun[]> {
    try {
      const runs = await loadActionsRuns(input);
      const matchingRuns = runs.filter((workflowRun) => workflowRun.head_sha === input.sha);
      return latestGiteaActionsRunsByWorkflow(matchingRuns);
    } catch (error) {
      rethrowTeaAuthFailure(error);
      return [];
    }
  }

  // The tasks endpoint pages at a small server default (10 on gitea.com) and a
  // self-hosted cap can sit below our requested 50; it also cannot filter by ref
  // or sha server-side. A short page therefore does NOT mean the last page —
  // conflating the two drops the current PR's run on a capped instance. Page on
  // until the target sha is found, a page comes back empty, or the bounded
  // max-pages cap is hit.
  async function loadActionsRuns(input: {
    cwd: string;
    repoOwner: string;
    repoName: string;
    sha: string;
  }): Promise<GiteaActionsRun[]> {
    const owner = encodeURIComponent(input.repoOwner);
    const repo = encodeURIComponent(input.repoName);
    const runs: GiteaActionsRun[] = [];
    let fetched = 0;
    for (let page = 1; page <= GITEA_ACTIONS_RUNS_MAX_PAGES; page += 1) {
      const batch = await runJson(
        [
          "api",
          `repos/${owner}/${repo}/actions/tasks?limit=${GITEA_ACTIONS_RUNS_PAGE_LIMIT}&page=${page}`,
        ],
        { cwd: input.cwd },
        GiteaActionsRunsSchema,
      );
      if (batch.workflow_runs.length === 0) {
        break;
      }
      fetched += batch.workflow_runs.length;
      runs.push(...parseGiteaActionsRuns(batch.workflow_runs));
      if (runs.some((workflowRun) => workflowRun.head_sha === input.sha)) {
        break;
      }
      // Stop once the whole result set is fetched: relying on a short page as
      // the terminator is unsafe on instances whose page cap is below the
      // requested limit, but `total_count` bounds the walk exactly, so a sha
      // with no run does not pay the full max-page fan-out.
      if (batch.total_count !== undefined && fetched >= batch.total_count) {
        break;
      }
    }
    return runs;
  }

  async function resolveCurrentPullRequestHeadSha(cwd: string): Promise<string> {
    const headRef = await resolveCurrentBranch(cwd);
    if (!headRef) {
      throw new Error("Gitea check details require a current branch");
    }
    const cacheKey = `${cwd}:branch:${headRef}`;
    const cached = currentPrHeadShaCache.get(cacheKey);
    const nowMs = now();
    if (cached && cached.expiresAt > nowMs) {
      return cached.sha;
    }
    const match = await findCurrentPullRequestForHeadRef({ cwd, headRef });
    const number = match ? parseGiteaInt(match.index) : null;
    if (!match || number === null) {
      throw new Error(`Gitea pull request for branch ${headRef} was not found`);
    }
    const pr = await runJson(
      ["pr", String(number), "-o", "json"],
      { cwd },
      GiteaPullRequestViewSchema,
    );
    if (!pr.headSha) {
      throw new Error(`Gitea pull request #${number} did not include a head SHA`);
    }
    currentPrHeadShaCache.set(cacheKey, {
      sha: pr.headSha,
      expiresAt: nowMs + CURRENT_PR_HEAD_SHA_CACHE_TTL_MS,
    });
    return pr.headSha;
  }

  // Resolve the head SHA of a specific PR by its number. The current branch's
  // head can move (a push right after a run was listed), so a user-triggered
  // check-details request for a known PR must resolve against that PR's head,
  // not the branch's, or the requested run no longer maps to the SHA.
  async function resolvePullRequestHeadShaByNumber(cwd: string, number: number): Promise<string> {
    const cacheKey = `${cwd}:pr:${number}`;
    const cached = currentPrHeadShaCache.get(cacheKey);
    const nowMs = now();
    if (cached && cached.expiresAt > nowMs) {
      return cached.sha;
    }
    const pr = await runJson(
      ["pr", String(number), "-o", "json"],
      { cwd },
      GiteaPullRequestViewSchema,
    );
    if (!pr.headSha) {
      throw new Error(`Gitea pull request #${number} did not include a head SHA`);
    }
    currentPrHeadShaCache.set(cacheKey, {
      sha: pr.headSha,
      expiresAt: nowMs + CURRENT_PR_HEAD_SHA_CACHE_TTL_MS,
    });
    return pr.headSha;
  }

  function toGiteaCheckDetails(status: GiteaCommitStatus): CheckDetails {
    return {
      checkRunId: status.id,
      name: status.context || `status-${status.id}`,
      status: status.status,
      conclusion: mapGiteaCommitStatus(status.status),
      url: status.target_url ?? null,
      detailsUrl: status.url ?? null,
      output:
        status.description != null
          ? {
              title: status.context || null,
              summary: status.description,
              text: null,
            }
          : null,
      annotations: [],
      failedJobs: [],
      truncated: false,
    };
  }

  function toGiteaActionsCheckDetails(workflowRun: GiteaActionsRun): CheckDetails {
    const conclusion = mapGiteaActionsRunStatus(workflowRun.status);
    return {
      checkRunId: workflowRun.id,
      workflowRunId: workflowRun.id,
      name: getGiteaActionsRunName(workflowRun),
      status: workflowRun.status,
      conclusion,
      url: workflowRun.url ?? null,
      detailsUrl: workflowRun.url ?? null,
      output: {
        title: workflowRun.display_title ?? workflowRun.name ?? workflowRun.workflow_id ?? null,
        summary: workflowRun.workflow_id ?? null,
        text: null,
      },
      annotations: [],
      failedJobs: [],
      truncated: false,
    };
  }

  function notSupported(method: string): never {
    throw new Error(`${method} is not supported on Gitea yet`);
  }

  return {
    async isAuthenticated(input: { cwd: string } & ForgeReadOptions): Promise<boolean> {
      const teaPath = await resolveTea();
      if (!teaPath) {
        return false;
      }
      const remoteUrl = await resolveRemoteUrl(input.cwd);
      const host = remoteUrl ? parseGiteaHostFromRemoteUrl(remoteUrl) : null;
      if (!host) {
        return false;
      }
      try {
        const stdout = await run(["login", "list", "-o", "json"], { cwd: input.cwd });
        return hostHasLogin(stdout, host);
      } catch {
        return false;
      }
    },

    getCurrentPullRequestStatus(input): Promise<CurrentPullRequestStatus | null> {
      return loadCurrentPullRequestStatus({
        cwd: input.cwd,
        headRef: input.headRef,
        headSha: input.headSha,
      });
    },

    async getPullRequest(input: GetPullRequestOptions): Promise<PullRequestSummary> {
      // Fetch the single PR by number (like gh `pr view <n>` / glab MR view) so
      // PRs outside the recent-list window are reachable; tea errors surface as
      // a not-found rather than silently missing.
      const view = await runJson(
        ["pr", String(input.number), "-o", "json"],
        { cwd: input.cwd },
        GiteaPullRequestViewSchema,
      );
      return viewToPullRequestSummary(view);
    },

    async getPullRequestHeadRef(input: GetPullRequestOptions): Promise<string> {
      const summary = await this.getPullRequest(input);
      return summary.headRefName;
    },

    async getPullRequestCheckoutTarget(
      input: GetPullRequestOptions,
    ): Promise<PullRequestCheckoutTarget> {
      const summary = await this.getPullRequest(input);
      const checkoutRefs = [
        { remoteName: "origin", remoteRef: `refs/pull/${summary.number}/head` },
      ];
      if (summary.headRefName) {
        checkoutRefs.push({ remoteName: "origin", remoteRef: `refs/heads/${summary.headRefName}` });
      }
      const fork = await resolveForkCheckoutFacts(input.cwd, summary);
      return {
        number: summary.number,
        baseRefName: summary.baseRefName,
        headRefName: summary.headRefName,
        checkoutRefs,
        headOwnerLogin: fork.headOwnerLogin,
        headRepositorySshUrl: fork.headRepositorySshUrl,
        headRepositoryUrl: fork.headRepositoryUrl,
        isCrossRepository: fork.isCrossRepository,
      };
    },

    listPullRequests(input: ListPullRequestsOptions): Promise<PullRequestSummary[]> {
      return listPullRequestItems({
        cwd: input.cwd,
        state: "open",
        query: input.query,
        limit: input.limit,
      }).then((items) => items.map(toPullRequestSummary));
    },

    listIssues(input: ListIssuesOptions): Promise<IssueSummary[]> {
      return runIssueList(input);
    },

    async createPullRequest(input: CreatePullRequestOptions): Promise<PullRequestCreateResult> {
      const args = [
        "pr",
        "create",
        "--title",
        input.title,
        "--description",
        input.body ?? "",
        "--head",
        input.head,
        "--base",
        input.base,
      ];
      const stdout = await run(args, { cwd: input.cwd });
      const url = extractPullRequestUrl(stdout);
      if (!url) {
        throw new TeaCommandError({
          args: redactTeaArgs(args),
          cwd: input.cwd,
          exitCode: null,
          stderr: "tea reported a created pull request but returned no URL",
        });
      }
      const number = parseIndexFromUrl(url);
      if (number === null) {
        throw new TeaCommandError({
          args: redactTeaArgs(args),
          cwd: input.cwd,
          exitCode: null,
          stderr: `tea returned a pull request URL without an index: ${url}`,
        });
      }
      return { url, number };
    },

    async mergePullRequest(input: MergePullRequestOptions): Promise<PullRequestMergeResult> {
      assertGiteaDirectMergeReady(input);
      const args = ["pr", "merge", String(input.prNumber), "--style", input.mergeMethod];
      await run(args, { cwd: input.cwd });
      return { success: true };
    },

    async getPullRequestTimeline(
      input: GetPullRequestTimelineOptions,
    ): Promise<PullRequestTimeline> {
      const identity = {
        prNumber: input.prNumber,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
      };
      try {
        const pr = await runJson(
          ["pr", String(input.prNumber), "-o", "json"],
          { cwd: input.cwd },
          GiteaPullRequestViewSchema,
        );
        const [commentsResult, reviewsResult] = await Promise.allSettled([
          listTimelineBucketPages(
            input,
            `issues/${input.prNumber}/comments`,
            GiteaIssueCommentSchema,
          ),
          listTimelineBucketPages(input, `pulls/${input.prNumber}/reviews`, GiteaReviewSchema),
        ]);
        if (commentsResult.status === "rejected" && reviewsResult.status === "rejected") {
          return {
            ...identity,
            items: [],
            truncated: false,
            error: mapGiteaTimelineError(commentsResult.reason),
          };
        }
        const commentsBucket =
          commentsResult.status === "fulfilled"
            ? commentsResult.value
            : { items: [], truncated: false };
        const reviewsBucket =
          reviewsResult.status === "fulfilled"
            ? reviewsResult.value
            : { items: [], truncated: false };
        const comments = commentsBucket.items;
        const reviews = reviewsBucket.items;
        const reviewsWithComments = reviews.filter((review) => review.comments_count > 0);
        const reviewCommentResults = await Promise.allSettled(
          reviewsWithComments.map((review) =>
            reviewCommentsLimit(() =>
              listPullRequestReviewComments({
                cwd: input.cwd,
                repoOwner: input.repoOwner,
                repoName: input.repoName,
                prNumber: input.prNumber,
                reviewId: review.id,
              }),
            ),
          ),
        );
        const reviewCommentGroups = reviewCommentResults.flatMap((result, index) =>
          result.status === "fulfilled"
            ? [
                {
                  reviewId: reviewsWithComments[index].id,
                  comments: result.value.items,
                  truncated: result.value.truncated,
                },
              ]
            : [],
        );
        const reviewComments = reviewCommentGroups.flatMap((group) => group.comments);
        const items = [
          ...comments.map((comment) => toGiteaTimelineComment(comment, pr)),
          ...reviews.map(toGiteaTimelineReview),
          ...reviewComments.map(toGiteaTimelineReviewComment),
        ]
          .filter((item): item is PullRequestTimelineItem => item !== null)
          .sort(compareTimelineItems);
        const truncated =
          commentsBucket.truncated ||
          reviewsBucket.truncated ||
          reviewCommentGroups.some((group) => group.truncated);
        return {
          ...identity,
          items,
          truncated,
          error: null,
        };
      } catch (error) {
        return { ...identity, items: [], truncated: false, error: mapGiteaTimelineError(error) };
      }
    },

    async getCheckDetails(input: GetCheckDetailsOptions): Promise<CheckDetails> {
      if (!input.repoOwner || !input.repoName) {
        throw new Error("Gitea getCheckDetails requires repoOwner and repoName");
      }
      if (input.checkRunId === undefined && input.workflowRunId === undefined) {
        throw new Error("Gitea getCheckDetails requires a checkRunId or workflowRunId");
      }
      const sha =
        input.changeRequestNumber !== undefined
          ? await resolvePullRequestHeadShaByNumber(input.cwd, input.changeRequestNumber)
          : await resolveCurrentPullRequestHeadSha(input.cwd);
      const combined = await loadCombinedCommitStatusBestEffort({
        cwd: input.cwd,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        sha,
      });
      const status = combined.statuses.find((entry) => entry.id === input.checkRunId);
      if (status) {
        return toGiteaCheckDetails(status);
      }
      const runs = await loadActionsRunsBestEffort({
        cwd: input.cwd,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        sha,
      });
      const workflowRunId = input.workflowRunId ?? input.checkRunId;
      const workflowRun = runs.find((entry) => entry.id === workflowRunId);
      if (!workflowRun) {
        throw new Error(`Gitea check ${workflowRunId} was not found`);
      }
      return toGiteaActionsCheckDetails(workflowRun);
    },

    async searchIssuesAndPrs(input: SearchIssuesAndPrsOptions): Promise<SearchResult> {
      if (input.force && !input.reason) {
        throw new Error("ForgeService forced read requires a reason");
      }

      const kinds = normalizeForgeSearchKinds(input.kinds);
      const shouldFetchIssues = kinds.includes("issue");
      const shouldFetchMergeRequests = kinds.includes("change_request");
      const [issuesResult, mergeRequestsResult] = await Promise.allSettled([
        shouldFetchIssues
          ? runIssueList({ cwd: input.cwd, query: input.query, limit: input.limit })
          : Promise.resolve(null),
        shouldFetchMergeRequests
          ? listPullRequestItems({
              cwd: input.cwd,
              state: "open",
              query: input.query,
              limit: input.limit,
            }).then((items) => items.map(toPullRequestSummary))
          : Promise.resolve(null),
      ]);

      const requestedResults = [
        shouldFetchIssues ? issuesResult : null,
        shouldFetchMergeRequests ? mergeRequestsResult : null,
      ].filter((result) => result !== null);
      const unavailableAuthState = getTeaUnavailableSearchAuthState(requestedResults);
      if (unavailableAuthState) {
        return createUnavailableSearchResult(unavailableAuthState);
      }
      throwFirstNonTeaAuthSearchRejection(requestedResults);

      const items: SearchResult["items"] = [];
      if (shouldFetchIssues && issuesResult.status === "fulfilled") {
        for (const issue of issuesResult.value ?? []) {
          items.push({
            kind: "issue",
            number: issue.number,
            title: issue.title,
            url: issue.url,
            state: issue.state,
            body: issue.body,
            labels: issue.labels,
            ...(issue.projectPath ? { projectPath: issue.projectPath } : {}),
            baseRefName: null,
            headRefName: null,
            updatedAt: issue.updatedAt,
          });
        }
      }
      if (shouldFetchMergeRequests && mergeRequestsResult.status === "fulfilled") {
        for (const pullRequest of mergeRequestsResult.value ?? []) {
          items.push({
            kind: "change_request",
            number: pullRequest.number,
            title: pullRequest.title,
            url: pullRequest.url,
            state: pullRequest.state,
            body: pullRequest.body,
            labels: pullRequest.labels,
            ...(pullRequest.projectPath ? { projectPath: pullRequest.projectPath } : {}),
            baseRefName: pullRequest.baseRefName,
            headRefName: pullRequest.headRefName,
            updatedAt: pullRequest.updatedAt,
          });
        }
      }
      items.sort(
        (left, right) => parseOptionalTime(right.updatedAt) - parseOptionalTime(left.updatedAt),
      );

      return {
        items,
        featuresEnabled: true,
        authState: "authenticated",
        githubFeaturesEnabled: true,
      };
    },

    enablePullRequestAutoMerge(_input: EnablePullRequestAutoMergeOptions): never {
      return notSupported("enablePullRequestAutoMerge");
    },

    disablePullRequestAutoMerge(_input: DisablePullRequestAutoMergeOptions): never {
      return notSupported("disablePullRequestAutoMerge");
    },

    invalidate(input: { cwd: string }): void {
      const prefix = `${input.cwd}:`;
      for (const key of currentPrHeadShaCache.keys()) {
        if (key.startsWith(prefix)) {
          currentPrHeadShaCache.delete(key);
        }
      }
    },
  };
}
