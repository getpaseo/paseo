import { z } from "zod";
import { findExecutable } from "../utils/executable.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { execCommand } from "../utils/spawn.js";

const DEFAULT_GITHUB_CACHE_TTL_MS = 30_000;
const GITHUB_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
};

const LabelSchema = z.object({
  name: z.string().optional(),
});

const GitHubIssueSummarySchema = z.object({
  number: z.number(),
  title: z.string().catch(""),
  url: z.string().catch(""),
  state: z.string().catch(""),
  body: z.string().nullable().catch(null),
  labels: z.array(LabelSchema).catch([]),
});

const GitHubPullRequestSummarySchema = z.object({
  number: z.number(),
  title: z.string().catch(""),
  url: z.string().catch(""),
  state: z.string().catch(""),
  body: z.string().nullable().catch(null),
  baseRefName: z.string().catch(""),
  headRefName: z.string().catch(""),
  labels: z.array(LabelSchema).catch([]),
});

const PullRequestCheckRunNodeSchema = z.object({
  __typename: z.literal("CheckRun"),
  name: z.string(),
  conclusion: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  detailsUrl: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  checkSuite: z
    .object({
      workflowRun: z
        .object({
          databaseId: z.number().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

const PullRequestStatusContextNodeSchema = z.object({
  __typename: z.literal("StatusContext"),
  context: z.string(),
  state: z.string().nullable().optional(),
  targetUrl: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
});

const PullRequestStatusCheckRollupNodeSchema = z.discriminatedUnion("__typename", [
  PullRequestCheckRunNodeSchema,
  PullRequestStatusContextNodeSchema,
]);

const PullRequestStatusCheckRollupArraySchema = z.array(z.unknown());
const LegacyPullRequestStatusCheckRollupSchema = z.object({
  contexts: z.array(z.unknown()),
});

const PullRequestReviewDecisionSchema = z
  .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
  .nullable()
  .catch(null);

const CurrentPullRequestStatusSchema = z.object({
  url: z.string().catch(""),
  title: z.string().catch(""),
  state: z.string().catch(""),
  baseRefName: z.string().catch(""),
  headRefName: z.string().catch(""),
  mergedAt: z.string().nullable().optional(),
  statusCheckRollup: z.unknown().optional(),
  reviewDecision: z.unknown().optional(),
});

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  cwd: string;
}

interface GitHubServiceDependencies {
  runner: GitHubCommandRunner;
  resolveGhPath: () => Promise<string | null>;
  now: () => number;
}

export interface GitHubCommandRunnerOptions {
  cwd: string;
}

export interface GitHubCommandResult {
  stdout: string;
  stderr: string;
}

export type GitHubCommandRunner = (
  args: string[],
  options: GitHubCommandRunnerOptions,
) => Promise<GitHubCommandResult>;

export interface GitHubPullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  body: string | null;
  baseRefName: string;
  headRefName: string;
  labels: string[];
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  body: string | null;
  labels: string[];
}

export type PullRequestCheckStatus = "pending" | "success" | "failure" | "cancelled" | "skipped";

export interface PullRequestCheck {
  name: string;
  status: PullRequestCheckStatus;
  url: string | null;
}

export type PullRequestChecksStatus = "none" | "pending" | "success" | "failure";
export type PullRequestReviewDecision = "approved" | "changes_requested" | "pending" | null;

export interface GitHubCurrentPullRequestStatus {
  url: string;
  title: string;
  state: string;
  baseRefName: string;
  headRefName: string;
  isMerged: boolean;
  checks: PullRequestCheck[];
  checksStatus: PullRequestChecksStatus;
  reviewDecision: PullRequestReviewDecision;
}

export interface GitHubPullRequestCreateResult {
  url: string;
  number: number;
}

export interface ListGitHubPullRequestsOptions {
  cwd: string;
  query?: string;
  limit?: number;
}

export interface ListGitHubIssuesOptions {
  cwd: string;
  query?: string;
  limit?: number;
}

export interface GetGitHubPullRequestOptions {
  cwd: string;
  number: number;
}

export interface CreateGitHubPullRequestOptions {
  cwd: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
}

export interface GitHubService {
  listPullRequests(options: ListGitHubPullRequestsOptions): Promise<GitHubPullRequestSummary[]>;
  listIssues(options: ListGitHubIssuesOptions): Promise<GitHubIssueSummary[]>;
  getPullRequest(options: GetGitHubPullRequestOptions): Promise<GitHubPullRequestSummary>;
  getPullRequestHeadRef(options: GetGitHubPullRequestOptions): Promise<string>;
  getCurrentPullRequestStatus(options: {
    cwd: string;
    headRef: string;
  }): Promise<GitHubCurrentPullRequestStatus | null>;
  createPullRequest(
    options: CreateGitHubPullRequestOptions,
  ): Promise<GitHubPullRequestCreateResult>;
  isAuthenticated(options: { cwd: string }): Promise<boolean>;
  invalidate(options: { cwd: string }): void;
}

export class GitHubCliMissingError extends Error {
  readonly kind = "missing-cli";

  constructor() {
    super("GitHub CLI (gh) is not installed or not in PATH");
    this.name = "GitHubCliMissingError";
  }
}

export class GitHubAuthenticationError extends Error {
  readonly kind = "auth-failure";
  readonly stderr: string;

  constructor(params: { stderr: string }) {
    super("GitHub CLI authentication failed");
    this.name = "GitHubAuthenticationError";
    this.stderr = params.stderr;
  }
}

export class GitHubCommandError extends Error {
  readonly kind = "command-error";
  readonly args: string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(params: { args: string[]; cwd: string; exitCode: number | null; stderr: string }) {
    super(`GitHub CLI command failed: gh ${params.args.join(" ")}`);
    this.name = "GitHubCommandError";
    this.args = [...params.args];
    this.cwd = params.cwd;
    this.exitCode = params.exitCode;
    this.stderr = params.stderr;
  }
}

interface CreateGitHubServiceOptions {
  ttlMs?: number;
  runner?: GitHubCommandRunner;
  resolveGhPath?: () => Promise<string | null>;
  now?: () => number;
}

interface CommandFailureLike {
  code?: string | number | null;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  message?: string;
}

type PullRequestCheckRunNode = z.infer<typeof PullRequestCheckRunNodeSchema>;
type PullRequestStatusContextNode = z.infer<typeof PullRequestStatusContextNodeSchema>;

export function createGitHubService(options: CreateGitHubServiceOptions = {}): GitHubService {
  const ttlMs = options.ttlMs ?? DEFAULT_GITHUB_CACHE_TTL_MS;
  const deps: GitHubServiceDependencies = {
    runner: options.runner ?? runGhCommand,
    resolveGhPath: options.resolveGhPath ?? resolveGhPath,
    now: options.now ?? Date.now,
  };
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<unknown>>();

  async function cached<T>(params: {
    cwd: string;
    method: string;
    args: unknown;
    load: () => Promise<T>;
  }): Promise<T> {
    const key = buildCacheKey({
      cwd: params.cwd,
      method: params.method,
      args: params.args,
    });
    const cachedEntry = cache.get(key);
    const now = deps.now();
    if (cachedEntry && cachedEntry.expiresAt > now) {
      return cachedEntry.value as T;
    }

    const existing = inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const request = params
      .load()
      .then((value) => {
        cache.set(key, {
          value,
          cwd: params.cwd,
          expiresAt: deps.now() + ttlMs,
        });
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  }

  async function run(args: string[], options: GitHubCommandRunnerOptions): Promise<string> {
    const ghPath = await deps.resolveGhPath();
    if (!ghPath) {
      throw new GitHubCliMissingError();
    }
    try {
      const result = await deps.runner(args, options);
      return result.stdout.trim();
    } catch (error) {
      throw normalizeGitHubCommandError(error, {
        args,
        cwd: options.cwd,
      });
    }
  }

  return {
    listPullRequests(options) {
      return cached({
        cwd: options.cwd,
        method: "listPullRequests",
        args: { query: options.query ?? "", limit: options.limit ?? 20 },
        load: async () => {
          const stdout = await run(
            [
              "pr",
              "list",
              "--search",
              options.query ?? "",
              "--json",
              "number,title,url,state,body,labels,baseRefName,headRefName",
              "--limit",
              String(options.limit ?? 20),
            ],
            { cwd: options.cwd },
          );
          return parsePullRequestSummaries(stdout);
        },
      });
    },

    listIssues(options) {
      return cached({
        cwd: options.cwd,
        method: "listIssues",
        args: { query: options.query ?? "", limit: options.limit ?? 20 },
        load: async () => {
          const stdout = await run(
            [
              "issue",
              "list",
              "--search",
              options.query ?? "",
              "--json",
              "number,title,url,state,body,labels",
              "--limit",
              String(options.limit ?? 20),
            ],
            { cwd: options.cwd },
          );
          return parseIssueSummaries(stdout);
        },
      });
    },

    getPullRequest(options) {
      return cached({
        cwd: options.cwd,
        method: "getPullRequest",
        args: { number: options.number },
        load: async () => {
          const stdout = await run(
            [
              "pr",
              "view",
              String(options.number),
              "--json",
              "number,title,url,state,body,labels,baseRefName,headRefName",
            ],
            { cwd: options.cwd },
          );
          return parsePullRequestSummary(stdout);
        },
      });
    },

    async getPullRequestHeadRef(options) {
      const pullRequest = await this.getPullRequest(options);
      return pullRequest.headRefName;
    },

    getCurrentPullRequestStatus(options) {
      return cached({
        cwd: options.cwd,
        method: "getCurrentPullRequestStatus",
        args: { headRef: options.headRef },
        load: async () => {
          try {
            const stdout = await run(
              [
                "pr",
                "view",
                "--json",
                "url,title,state,baseRefName,headRefName,mergedAt,statusCheckRollup,reviewDecision",
              ],
              { cwd: options.cwd },
            );
            return parseCurrentPullRequestStatus(stdout, options.headRef);
          } catch (error) {
            if (isNoPullRequestFoundError(error)) {
              return null;
            }
            throw error;
          }
        },
      });
    },

    async createPullRequest(options) {
      const args = [
        "api",
        "-X",
        "POST",
        `repos/${options.repo}/pulls`,
        "-f",
        `title=${options.title}`,
      ];
      args.push("-f", `head=${options.head}`);
      args.push("-f", `base=${options.base}`);
      if (options.body) {
        args.push("-f", `body=${options.body}`);
      }
      const stdout = await run(args, { cwd: options.cwd });
      const parsed = z
        .object({
          url: z.string(),
          number: z.number(),
        })
        .parse(JSON.parse(stdout || "{}"));
      return parsed;
    },

    isAuthenticated(options) {
      return cached({
        cwd: options.cwd,
        method: "isAuthenticated",
        args: {},
        load: async () => {
          try {
            await run(["auth", "status"], { cwd: options.cwd });
            return true;
          } catch (error) {
            if (isGitHubAuthenticationError(error)) {
              throw error;
            }
            if (error instanceof GitHubCommandError && isAuthFailureText(error.stderr)) {
              throw new GitHubAuthenticationError({ stderr: error.stderr });
            }
            throw error;
          }
        },
      });
    },

    invalidate(options) {
      for (const [key, entry] of cache.entries()) {
        if (entry.cwd === options.cwd) {
          cache.delete(key);
        }
      }
    },
  };
}

async function resolveGhPath(): Promise<string | null> {
  return findExecutable("gh");
}

async function runGhCommand(
  args: string[],
  options: GitHubCommandRunnerOptions,
): Promise<GitHubCommandResult> {
  return execCommand("gh", args, {
    cwd: options.cwd,
    env: GITHUB_ENV,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function buildCacheKey(params: { cwd: string; method: string; args: unknown }): string {
  return `${params.cwd}:${params.method}:${stableStringify(params.args)}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  const sorted: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    sorted[key] = sortJsonValue(entryValue);
  }
  return sorted;
}

function normalizeGitHubCommandError(
  error: unknown,
  context: { args: string[]; cwd: string },
): Error {
  if (error instanceof GitHubAuthenticationError) {
    return error;
  }
  if (error instanceof GitHubCommandError) {
    if (isAuthFailureText(error.stderr)) {
      return new GitHubAuthenticationError({ stderr: error.stderr });
    }
    return error;
  }
  const failure = toCommandFailureLike(error);
  if (failure.code === "ENOENT") {
    return new GitHubCliMissingError();
  }
  const stderr = bufferOrStringToString(failure.stderr);
  if (isAuthFailureText(stderr) || isAuthFailureText(failure.message ?? "")) {
    return new GitHubAuthenticationError({ stderr });
  }
  return new GitHubCommandError({
    args: context.args,
    cwd: context.cwd,
    exitCode: typeof failure.code === "number" ? failure.code : null,
    stderr,
  });
}

function toCommandFailureLike(error: unknown): CommandFailureLike {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }
  const record = error as Record<string, unknown>;
  return {
    code:
      typeof record.code === "string" || typeof record.code === "number" || record.code === null
        ? record.code
        : undefined,
    stderr:
      typeof record.stderr === "string" || Buffer.isBuffer(record.stderr)
        ? record.stderr
        : undefined,
    stdout:
      typeof record.stdout === "string" || Buffer.isBuffer(record.stdout)
        ? record.stdout
        : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

function bufferOrStringToString(value: string | Buffer | undefined): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return value ?? "";
}

function isGitHubAuthenticationError(error: unknown): error is GitHubAuthenticationError {
  return error instanceof GitHubAuthenticationError;
}

function isAuthFailureText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("gh auth login") ||
    normalized.includes("not logged into any github hosts") ||
    normalized.includes("authentication failed") ||
    normalized.includes("authentication required") ||
    normalized.includes("bad credentials") ||
    normalized.includes("http 401")
  );
}

function isNoPullRequestFoundError(error: unknown): boolean {
  if (!(error instanceof GitHubCommandError)) {
    return false;
  }
  const text = error.stderr.toLowerCase();
  return text.includes("no pull requests found") || text.includes("could not resolve");
}

function parsePullRequestSummaries(stdout: string): GitHubPullRequestSummary[] {
  const parsed = z.array(GitHubPullRequestSummarySchema).parse(JSON.parse(stdout || "[]"));
  return parsed.map(toPullRequestSummary);
}

function parsePullRequestSummary(stdout: string): GitHubPullRequestSummary {
  return toPullRequestSummary(GitHubPullRequestSummarySchema.parse(JSON.parse(stdout || "{}")));
}

function toPullRequestSummary(
  item: z.infer<typeof GitHubPullRequestSummarySchema>,
): GitHubPullRequestSummary {
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.state,
    body: item.body,
    baseRefName: item.baseRefName,
    headRefName: item.headRefName,
    labels: item.labels.map((label) => label.name ?? "").filter((name) => name.length > 0),
  };
}

function parseIssueSummaries(stdout: string): GitHubIssueSummary[] {
  const parsed = z.array(GitHubIssueSummarySchema).parse(JSON.parse(stdout || "[]"));
  return parsed.map((item) => ({
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.state,
    body: item.body,
    labels: item.labels.map((label) => label.name ?? "").filter((name) => name.length > 0),
  }));
}

function parseCurrentPullRequestStatus(
  stdout: string,
  fallbackHeadRefName: string,
): GitHubCurrentPullRequestStatus | null {
  const item = CurrentPullRequestStatusSchema.parse(JSON.parse(stdout || "{}"));
  if (!item.url || !item.title) {
    return null;
  }
  const mergedAt =
    typeof item.mergedAt === "string" && item.mergedAt.trim().length > 0 ? item.mergedAt : null;
  const state =
    mergedAt !== null ? "merged" : item.state.trim().length > 0 ? item.state.toLowerCase() : "";
  const checks = parseStatusCheckRollup(item.statusCheckRollup);
  return {
    url: item.url,
    title: item.title,
    state,
    baseRefName: item.baseRefName,
    headRefName: item.headRefName || fallbackHeadRefName,
    isMerged: mergedAt !== null,
    checks,
    checksStatus: computeChecksStatus(checks),
    reviewDecision: mapReviewDecision(item.reviewDecision),
  };
}

export function parseStatusCheckRollup(value: unknown): PullRequestCheck[] {
  const directContexts = PullRequestStatusCheckRollupArraySchema.safeParse(value);
  if (!directContexts.success) {
    const legacyContexts = LegacyPullRequestStatusCheckRollupSchema.safeParse(value);
    if (!legacyContexts.success) {
      return [];
    }
    return parseStatusCheckRollup(legacyContexts.data.contexts);
  }

  const dedupedChecks = new Map<string, PullRequestCheck & { recency: number }>();
  for (const entry of directContexts.data) {
    const parsed = PullRequestStatusCheckRollupNodeSchema.safeParse(entry);
    if (!parsed.success) {
      continue;
    }
    const check = buildPullRequestCheck(parsed.data);
    if (!check) {
      continue;
    }
    const existing = dedupedChecks.get(check.name);
    if (!existing || check.recency > existing.recency) {
      dedupedChecks.set(check.name, check);
    }
  }

  return Array.from(dedupedChecks.values(), ({ recency: _recency, ...check }) => check);
}

function buildPullRequestCheck(
  context: z.infer<typeof PullRequestStatusCheckRollupNodeSchema>,
): (PullRequestCheck & { recency: number }) | null {
  if (context.__typename === "CheckRun") {
    return {
      name: context.name,
      status: mapCheckRunStatus(context.status, context.conclusion),
      url: typeof context.detailsUrl === "string" ? context.detailsUrl : null,
      recency: getCheckRunRecency(context),
    };
  }
  if (context.__typename === "StatusContext") {
    return {
      name: context.context,
      status: mapStatusContextState(context.state),
      url: typeof context.targetUrl === "string" ? context.targetUrl : null,
      recency: getStatusContextRecency(context),
    };
  }
  return null;
}

function mapCheckRunStatus(status: unknown, conclusion: unknown): PullRequestCheckStatus {
  if (status !== "COMPLETED") {
    return "pending";
  }
  switch (conclusion) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
    case "NEUTRAL":
      return "skipped";
    default:
      return "pending";
  }
}

function mapStatusContextState(state: unknown): PullRequestCheckStatus {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "EXPECTED":
    case "PENDING":
      return "pending";
    default:
      return "pending";
  }
}

function getCheckRunRecency(context: PullRequestCheckRunNode): number {
  const workflowRunId = context.checkSuite?.workflowRun?.databaseId;
  if (typeof workflowRunId === "number") {
    return workflowRunId;
  }
  return parseOptionalTime(context.completedAt ?? context.startedAt ?? null);
}

function getStatusContextRecency(context: PullRequestStatusContextNode): number {
  return parseOptionalTime(context.createdAt ?? null);
}

function parseOptionalTime(timestamp: string | null): number {
  if (!timestamp) {
    return 0;
  }
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? 0 : time;
}

function computeChecksStatus(checks: PullRequestCheck[]): PullRequestChecksStatus {
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

function mapReviewDecision(value: unknown): PullRequestReviewDecision {
  const reviewDecision = PullRequestReviewDecisionSchema.parse(value);
  if (reviewDecision === "APPROVED") {
    return "approved";
  }
  if (reviewDecision === "CHANGES_REQUESTED") {
    return "changes_requested";
  }
  if (reviewDecision === "REVIEW_REQUIRED") {
    return "pending";
  }
  return null;
}

export async function resolveGitHubRepo(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["config", "--get", "remote.origin.url"], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return parseGitHubRepoFromRemote(stdout.trim());
  } catch {
    return null;
  }
}

function parseGitHubRepoFromRemote(url: string): string | null {
  if (!url) {
    return null;
  }
  let cleaned = url;
  if (cleaned.startsWith("git@github.com:")) {
    cleaned = cleaned.slice("git@github.com:".length);
  } else if (cleaned.startsWith("https://github.com/")) {
    cleaned = cleaned.slice("https://github.com/".length);
  } else if (cleaned.startsWith("http://github.com/")) {
    cleaned = cleaned.slice("http://github.com/".length);
  } else {
    const marker = "github.com/";
    const index = cleaned.indexOf(marker);
    if (index === -1) {
      return null;
    }
    cleaned = cleaned.slice(index + marker.length);
  }
  if (cleaned.endsWith(".git")) {
    cleaned = cleaned.slice(0, -".git".length);
  }
  return cleaned.includes("/") ? cleaned : null;
}
