import { z } from "zod";
import type { GitHubSearchKind } from "../shared/messages.js";
import { findExecutable } from "../utils/executable.js";
import { execCommand } from "../utils/spawn.js";

const DEFAULT_GITHUB_CACHE_TTL_MS = 30_000;
export const GITHUB_POLL_FAST_INTERVAL_MS = 20_000;
export const GITHUB_POLL_SLOW_INTERVAL_MS = 120_000;
export const GITHUB_POLL_ERROR_BACKOFF_CAP_MS = 300_000;
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
  updatedAt: z.string().catch(""),
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
  updatedAt: z.string().catch(""),
});

const PullRequestCheckRunNodeSchema = z.object({
  __typename: z.literal("CheckRun"),
  name: z.string(),
  workflowName: z.string().nullable().optional(),
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

const HeadRepositoryOwnerSchema = z
  .object({
    login: z.string().optional(),
  })
  .nullable()
  .optional();

const CurrentPullRequestStatusSchema = z.object({
  number: z.number().optional(),
  url: z.string().catch(""),
  title: z.string().catch(""),
  state: z.string().catch(""),
  isDraft: z.boolean().optional().catch(false),
  baseRefName: z.string().catch(""),
  headRefName: z.string().catch(""),
  mergedAt: z.string().nullable().optional(),
  statusCheckRollup: z.unknown().optional(),
  reviewDecision: z.unknown().optional(),
  headRepositoryOwner: HeadRepositoryOwnerSchema,
});

const TimelineAuthorSchema = z
  .object({
    login: z.string().optional(),
    url: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const PullRequestTimelineReviewNodeSchema = z.object({
  id: z.string().catch(""),
  state: z.string().catch(""),
  body: z.string().nullable().catch(null),
  url: z.string().catch(""),
  submittedAt: z.string().nullable().catch(null),
  author: TimelineAuthorSchema,
});

const PullRequestTimelineCommentNodeSchema = z.object({
  id: z.string().catch(""),
  body: z.string().nullable().catch(null),
  url: z.string().catch(""),
  createdAt: z.string().nullable().catch(null),
  author: TimelineAuthorSchema,
});

const PullRequestTimelinePageInfoSchema = z.object({
  hasNextPage: z.boolean().catch(false),
});

const PullRequestTimelineGraphqlSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              number: z.number().optional(),
              reviews: z
                .object({
                  nodes: z.array(PullRequestTimelineReviewNodeSchema).catch([]),
                  pageInfo: PullRequestTimelinePageInfoSchema.catch({ hasNextPage: false }),
                })
                .catch({ nodes: [], pageInfo: { hasNextPage: false } }),
              comments: z
                .object({
                  nodes: z.array(PullRequestTimelineCommentNodeSchema).catch([]),
                  pageInfo: PullRequestTimelinePageInfoSchema.catch({ hasNextPage: false }),
                })
                .catch({ nodes: [], pageInfo: { hasNextPage: false } }),
            })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

const GitHubRepoViewSchema = z.object({
  owner: z
    .object({
      login: z.string().optional(),
    })
    .nullable()
    .optional(),
  name: z.string().optional(),
  parent: z
    .object({
      owner: z
        .object({
          login: z.string().optional(),
        })
        .nullable()
        .optional(),
      name: z.string().optional(),
    })
    .nullable()
    .optional(),
});

const CURRENT_PR_STATUS_FIELDS =
  "number,url,title,state,isDraft,baseRefName,headRefName,mergedAt,statusCheckRollup,reviewDecision,headRepositoryOwner";

const PULL_REQUEST_TIMELINE_QUERY = `
query PullRequestTimeline($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      reviews(first: 100) {
        nodes {
          id
          state
          body
          url
          submittedAt
          author {
            login
            url
          }
        }
        pageInfo {
          hasNextPage
        }
      }
      comments(first: 100) {
        nodes {
          id
          body
          url
          createdAt
          author {
            login
            url
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
}`;

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
  updatedAt: string;
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  body: string | null;
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
}

export type PullRequestChecksStatus = "none" | "pending" | "success" | "failure";
export type PullRequestReviewDecision = "approved" | "changes_requested" | "pending" | null;

export interface GitHubCurrentPullRequestStatus {
  number?: number;
  repoOwner?: string;
  repoName?: string;
  url: string;
  title: string;
  state: string;
  baseRefName: string;
  headRefName: string;
  isMerged: boolean;
  isDraft?: boolean;
  checks: PullRequestCheck[];
  checksStatus: PullRequestChecksStatus;
  reviewDecision: PullRequestReviewDecision;
}

export type PullRequestTimelineReviewState = "approved" | "changes_requested" | "commented";

interface PullRequestTimelineItemBase {
  id: string;
  author: string;
  authorUrl: string | null;
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
    });

export type GitHubPullRequestTimelineErrorKind = "not_found" | "forbidden" | "unknown";

export interface GitHubPullRequestTimelineError {
  kind: GitHubPullRequestTimelineErrorKind;
  message: string;
}

export interface GitHubPullRequestTimeline {
  prNumber: number;
  repoOwner: string;
  repoName: string;
  items: PullRequestTimelineItem[];
  truncated: boolean;
  error: GitHubPullRequestTimelineError | null;
}

export interface GitHubPullRequestCreateResult {
  url: string;
  number: number;
}

export type GitHubReadOptions =
  | {
      force?: false;
      reason?: string;
    }
  | {
      force: true;
      reason: string;
    };

export type ListGitHubPullRequestsOptions = {
  cwd: string;
  query?: string;
  limit?: number;
} & GitHubReadOptions;

export type ListGitHubIssuesOptions = {
  cwd: string;
  query?: string;
  limit?: number;
} & GitHubReadOptions;

export type GetGitHubPullRequestOptions = {
  cwd: string;
  number: number;
} & GitHubReadOptions;

export type GetGitHubPullRequestTimelineOptions = {
  cwd: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
} & GitHubReadOptions;

export interface GitHubSearchResult {
  items: Array<{
    kind: "issue" | "pr";
    number: number;
    title: string;
    url: string;
    state: string;
    body: string | null;
    labels: string[];
    baseRefName?: string | null;
    headRefName?: string | null;
    updatedAt?: string;
  }>;
  githubFeaturesEnabled: boolean;
}

export type SearchGitHubIssuesAndPrsOptions = {
  cwd: string;
  query: string;
  limit?: number;
  kinds?: GitHubSearchKind[];
} & GitHubReadOptions;

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
  getCurrentPullRequestStatus(
    options: {
      cwd: string;
      headRef: string;
    } & GitHubReadOptions,
  ): Promise<GitHubCurrentPullRequestStatus | null>;
  getPullRequestTimeline(
    options: GetGitHubPullRequestTimelineOptions,
  ): Promise<GitHubPullRequestTimeline>;
  searchIssuesAndPrs(options: SearchGitHubIssuesAndPrsOptions): Promise<GitHubSearchResult>;
  createPullRequest(
    options: CreateGitHubPullRequestOptions,
  ): Promise<GitHubPullRequestCreateResult>;
  isAuthenticated(options: { cwd: string } & GitHubReadOptions): Promise<boolean>;
  retainCurrentPullRequestStatusPoll?(options: {
    cwd: string;
    headRef: string;
    onStatus?: (status: GitHubCurrentPullRequestStatus | null) => void;
    onError?: (error: unknown) => void;
  }): { unsubscribe: () => void };
  invalidate(options: { cwd: string }): void;
  dispose?(): void;
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
type CurrentPullRequestStatusItem = z.infer<typeof CurrentPullRequestStatusSchema>;

interface InFlightCacheEntry {
  cwd: string;
  promise: Promise<unknown>;
  force: boolean;
}

interface GitHubPollTarget {
  cwd: string;
  headRef: string;
  retainCount: number;
  timer: NodeJS.Timeout | null;
  latestStatus: GitHubCurrentPullRequestStatus | null;
  consecutiveErrors: number;
  callbacks: Set<(status: GitHubCurrentPullRequestStatus | null) => void>;
  errorCallbacks: Set<(error: unknown) => void>;
}

interface ResolvedPullRequestCandidate {
  status: GitHubCurrentPullRequestStatus;
  headRepositoryOwner?: string;
}

export function createGitHubService(options: CreateGitHubServiceOptions = {}): GitHubService {
  const ttlMs = options.ttlMs ?? DEFAULT_GITHUB_CACHE_TTL_MS;
  const deps: GitHubServiceDependencies = {
    runner: options.runner ?? runGhCommand,
    resolveGhPath: options.resolveGhPath ?? resolveGhPath,
    now: options.now ?? Date.now,
  };
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, InFlightCacheEntry>();
  const pollTargets = new Map<string, GitHubPollTarget>();
  let api!: GitHubService;

  async function cached<T>(params: {
    cwd: string;
    method: string;
    args: unknown;
    readOptions?: GitHubReadOptions;
    load: () => Promise<T>;
  }): Promise<T> {
    if (params.readOptions?.force && !params.readOptions.reason) {
      throw new Error("GitHubService forced read requires a reason");
    }

    const key = buildCacheKey({
      cwd: params.cwd,
      method: params.method,
      args: params.args,
    });
    const cachedEntry = cache.get(key);
    const now = deps.now();
    if (!params.readOptions?.force && cachedEntry && cachedEntry.expiresAt > now) {
      return cachedEntry.value as T;
    }

    const existing = inFlight.get(key);
    if (existing && (!params.readOptions?.force || existing.force)) {
      return existing.promise as Promise<T>;
    }

    const request = params
      .load()
      .then((value) => {
        if (inFlight.get(key)?.promise === request) {
          cache.set(key, {
            value,
            cwd: params.cwd,
            expiresAt: deps.now() + ttlMs,
          });
        }
        return value;
      })
      .finally(() => {
        if (inFlight.get(key)?.promise === request) {
          inFlight.delete(key);
        }
      });
    inFlight.set(key, {
      cwd: params.cwd,
      promise: request,
      force: params.readOptions?.force === true,
    });
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

  function getPollTargetKey(options: { cwd: string; headRef: string }): string {
    return buildCacheKey({
      cwd: options.cwd,
      method: "getCurrentPullRequestStatus",
      args: { headRef: options.headRef },
    });
  }

  function updatePollTargetAfterSuccess(options: {
    cwd: string;
    headRef: string;
    status: GitHubCurrentPullRequestStatus | null;
    notify: boolean;
  }): void {
    const target = pollTargets.get(getPollTargetKey(options));
    if (!target) {
      return;
    }

    target.latestStatus = options.status;
    target.consecutiveErrors = 0;
    if (options.notify) {
      for (const callback of target.callbacks) {
        callback(options.status);
      }
    }
    scheduleGitHubPoll(target);
  }

  function scheduleGitHubPoll(target: GitHubPollTarget): void {
    scheduleGitHubPollAfter(
      target,
      computeGithubNextInterval(target.latestStatus, target.consecutiveErrors),
    );
  }

  function scheduleImmediateGitHubPoll(target: GitHubPollTarget): void {
    scheduleGitHubPollAfter(target, 0);
  }

  function scheduleGitHubPollAfter(target: GitHubPollTarget, delayMs: number): void {
    if (target.retainCount <= 0) {
      return;
    }
    if (target.timer) {
      clearTimeout(target.timer);
    }

    target.timer = setTimeout(() => {
      target.timer = null;
      void runGitHubPoll(target);
    }, delayMs);
  }

  async function runGitHubPoll(target: GitHubPollTarget): Promise<void> {
    try {
      await api.getCurrentPullRequestStatus({
        cwd: target.cwd,
        headRef: target.headRef,
        reason: "self-heal-github",
      });
    } catch (error) {
      target.consecutiveErrors += 1;
      for (const callback of target.errorCallbacks) {
        callback(error);
      }
      scheduleGitHubPoll(target);
    }
  }

  function closeGitHubPollTarget(target: GitHubPollTarget): void {
    if (target.timer) {
      clearTimeout(target.timer);
      target.timer = null;
    }
    target.retainCount = 0;
    target.callbacks.clear();
    target.errorCallbacks.clear();
  }

  api = {
    listPullRequests(options) {
      return cached({
        cwd: options.cwd,
        method: "listPullRequests",
        args: { query: options.query ?? "", limit: options.limit ?? 20 },
        readOptions: options,
        load: async () => {
          const stdout = await run(
            [
              "pr",
              "list",
              "--search",
              options.query ?? "",
              "--json",
              "number,title,url,state,body,labels,baseRefName,headRefName,updatedAt",
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
        readOptions: options,
        load: async () => {
          const stdout = await run(
            [
              "issue",
              "list",
              "--search",
              options.query ?? "",
              "--json",
              "number,title,url,state,body,labels,updatedAt",
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
        readOptions: options,
        load: async () => {
          const stdout = await run(
            [
              "pr",
              "view",
              String(options.number),
              "--json",
              "number,title,url,state,body,labels,baseRefName,headRefName,updatedAt",
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
        readOptions: options,
        load: async () => {
          return resolveCurrentPullRequestView({
            cwd: options.cwd,
            headRef: options.headRef,
            run,
          });
        },
      }).then((status) => {
        updatePollTargetAfterSuccess({
          cwd: options.cwd,
          headRef: options.headRef,
          status,
          notify: options.reason === "self-heal-github",
        });
        return status;
      });
    },

    getPullRequestTimeline(options) {
      return cached({
        cwd: options.cwd,
        method: "getPullRequestTimeline",
        args: { prNumber: options.prNumber },
        readOptions: options,
        load: async () => {
          try {
            const stdout = await run(
              [
                "api",
                "graphql",
                "-f",
                `query=${PULL_REQUEST_TIMELINE_QUERY}`,
                "-F",
                `owner=${options.repoOwner}`,
                "-F",
                `name=${options.repoName}`,
                "-F",
                `number=${options.prNumber}`,
              ],
              { cwd: options.cwd },
            );
            return parsePullRequestTimeline(stdout, {
              prNumber: options.prNumber,
              repoOwner: options.repoOwner,
              repoName: options.repoName,
            });
          } catch (error) {
            return {
              prNumber: options.prNumber,
              repoOwner: options.repoOwner,
              repoName: options.repoName,
              items: [],
              truncated: false,
              error: mapPullRequestTimelineError(error),
            };
          }
        },
      });
    },

    async searchIssuesAndPrs(options) {
      if (options.force && !options.reason) {
        throw new Error("GitHubService forced read requires a reason");
      }

      const kinds = options.kinds ?? ["github-issue", "github-pr"];
      const shouldFetchIssues = kinds.includes("github-issue");
      const shouldFetchPullRequests = kinds.includes("github-pr");
      const readOptions: GitHubReadOptions = options.force
        ? { force: true, reason: options.reason }
        : { force: false, reason: options.reason };
      const [issuesResult, prsResult] = await Promise.allSettled([
        shouldFetchIssues
          ? this.listIssues({
              cwd: options.cwd,
              query: options.query,
              limit: options.limit,
              ...readOptions,
            })
          : Promise.resolve(null),
        shouldFetchPullRequests
          ? this.listPullRequests({
              cwd: options.cwd,
              query: options.query,
              limit: options.limit,
              ...readOptions,
            })
          : Promise.resolve(null),
      ]);

      const items: GitHubSearchResult["items"] = [];
      const requestedResults = [
        shouldFetchIssues ? issuesResult : null,
        shouldFetchPullRequests ? prsResult : null,
      ].filter((result) => result !== null);
      if (
        requestedResults.length > 0 &&
        requestedResults.every(
          (result) =>
            result.status === "rejected" &&
            (result.reason instanceof GitHubCliMissingError ||
              result.reason instanceof GitHubAuthenticationError),
        )
      ) {
        return { items: [], githubFeaturesEnabled: false };
      }

      if (shouldFetchIssues && issuesResult.status === "fulfilled") {
        for (const item of issuesResult.value ?? []) {
          items.push({
            kind: "issue",
            number: item.number,
            title: item.title,
            url: item.url,
            state: item.state,
            body: item.body,
            labels: item.labels,
            baseRefName: null,
            headRefName: null,
            updatedAt: item.updatedAt,
          });
        }
      }

      if (shouldFetchPullRequests && prsResult.status === "fulfilled") {
        for (const item of prsResult.value ?? []) {
          items.push({
            kind: "pr",
            number: item.number,
            title: item.title,
            url: item.url,
            state: item.state,
            body: item.body,
            labels: item.labels,
            baseRefName: item.baseRefName,
            headRefName: item.headRefName,
            updatedAt: item.updatedAt,
          });
        }
      }

      items.sort((left, right) => {
        const leftTime = parseOptionalTime(left.updatedAt ?? null);
        const rightTime = parseOptionalTime(right.updatedAt ?? null);
        return rightTime - leftTime;
      });

      return { items, githubFeaturesEnabled: true };
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
        readOptions: options,
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

    retainCurrentPullRequestStatusPoll(options) {
      const key = getPollTargetKey(options);
      let target = pollTargets.get(key);
      if (!target) {
        target = {
          cwd: options.cwd,
          headRef: options.headRef,
          retainCount: 0,
          timer: null,
          latestStatus: null,
          consecutiveErrors: 0,
          callbacks: new Set(),
          errorCallbacks: new Set(),
        };
        pollTargets.set(key, target);
      }

      const isNewlyRetained = target.retainCount === 0;
      target.retainCount += 1;
      if (options.onStatus) {
        target.callbacks.add(options.onStatus);
      }
      if (options.onError) {
        target.errorCallbacks.add(options.onError);
      }
      if (isNewlyRetained) {
        scheduleImmediateGitHubPoll(target);
      } else {
        scheduleGitHubPoll(target);
      }

      let unsubscribed = false;
      return {
        unsubscribe: () => {
          if (unsubscribed) {
            return;
          }
          unsubscribed = true;
          if (options.onStatus) {
            target.callbacks.delete(options.onStatus);
          }
          if (options.onError) {
            target.errorCallbacks.delete(options.onError);
          }
          target.retainCount -= 1;
          if (target.retainCount > 0) {
            return;
          }
          closeGitHubPollTarget(target);
          pollTargets.delete(key);
        },
      };
    },

    invalidate(options) {
      // Local checkout mutations that can alter the current PR identity or PR status
      // must call this with the affected cwd before broadcasting fresh git state.
      for (const [key, entry] of cache.entries()) {
        if (entry.cwd === options.cwd) {
          cache.delete(key);
        }
      }
      for (const [key, entry] of inFlight.entries()) {
        if (entry.cwd === options.cwd) {
          inFlight.delete(key);
        }
      }
    },

    dispose() {
      for (const target of pollTargets.values()) {
        closeGitHubPollTarget(target);
      }
      pollTargets.clear();
    },
  };

  return api;
}

export function computeGithubNextInterval(
  status: GitHubCurrentPullRequestStatus | null,
  consecutiveErrors: number,
): number {
  const baseInterval = isGitHubStatusPending(status)
    ? GITHUB_POLL_FAST_INTERVAL_MS
    : GITHUB_POLL_SLOW_INTERVAL_MS;
  if (consecutiveErrors <= 1) {
    return baseInterval;
  }

  return Math.min(baseInterval * 2 ** (consecutiveErrors - 1), GITHUB_POLL_ERROR_BACKOFF_CAP_MS);
}

function isGitHubStatusPending(status: GitHubCurrentPullRequestStatus | null): boolean {
  if (!status) {
    return false;
  }
  if (status.checksStatus === "pending") {
    return true;
  }
  return status.checks.some((check) => check.status === "pending");
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
  const message = failure.message ?? "";
  if (isAuthFailureText(stderr) || isAuthFailureText(message)) {
    return new GitHubAuthenticationError({ stderr });
  }
  return new GitHubCommandError({
    args: context.args,
    cwd: context.cwd,
    exitCode: typeof failure.code === "number" ? failure.code : null,
    stderr: stderr || message,
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
  return text.includes("no pull requests found");
}

async function resolveCurrentPullRequestView(options: {
  cwd: string;
  headRef: string;
  run: (args: string[], options: GitHubCommandRunnerOptions) => Promise<string>;
}): Promise<GitHubCurrentPullRequestStatus | null> {
  const viewCandidate = await tryCurrentPullRequestView(options);
  if (viewCandidate && isCandidateForHeadRef(viewCandidate, options.headRef)) {
    return viewCandidate.status;
  }

  const repo = await getGitHubRepoView(options);
  const forkOwner = repo?.owner?.login;
  const parentOwner = repo?.parent?.owner?.login;
  const parentName = repo?.parent?.name;
  if (!forkOwner || !parentOwner || !parentName) {
    return null;
  }

  const parentCandidates = await listCurrentPullRequestCandidates({
    cwd: options.cwd,
    headRef: `${forkOwner}:${options.headRef}`,
    run: options.run,
    repo: `${parentOwner}/${parentName}`,
  });
  const parentMatch = pickPullRequestCandidate({
    candidates: parentCandidates,
    headRef: options.headRef,
    headRepositoryOwner: forkOwner,
  });
  return parentMatch?.status ?? null;
}

async function tryCurrentPullRequestView(options: {
  cwd: string;
  headRef: string;
  run: (args: string[], options: GitHubCommandRunnerOptions) => Promise<string>;
}): Promise<ResolvedPullRequestCandidate | null> {
  try {
    const stdout = await options.run(["pr", "view", "--json", CURRENT_PR_STATUS_FIELDS], {
      cwd: options.cwd,
    });
    return parseCurrentPullRequestCandidate(stdout, options.headRef);
  } catch (error) {
    if (isNoPullRequestFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function listCurrentPullRequestCandidates(options: {
  cwd: string;
  headRef: string;
  run: (args: string[], options: GitHubCommandRunnerOptions) => Promise<string>;
  repo?: string;
}): Promise<ResolvedPullRequestCandidate[]> {
  const args = ["pr", "list"];
  if (options.repo) {
    args.push("--repo", options.repo);
  }
  args.push(
    "--state",
    "all",
    "--head",
    options.headRef,
    "--json",
    CURRENT_PR_STATUS_FIELDS,
    "--limit",
    "10",
  );
  try {
    const stdout = await options.run(args, { cwd: options.cwd });
    return parseCurrentPullRequestCandidateList(stdout, options.headRef);
  } catch (error) {
    if (isNoPullRequestFoundError(error)) {
      return [];
    }
    throw error;
  }
}

async function getGitHubRepoView(options: {
  cwd: string;
  run: (args: string[], options: GitHubCommandRunnerOptions) => Promise<string>;
}): Promise<z.infer<typeof GitHubRepoViewSchema> | null> {
  try {
    const stdout = await options.run(["repo", "view", "--json", "owner,name,parent"], {
      cwd: options.cwd,
    });
    return GitHubRepoViewSchema.parse(JSON.parse(stdout || "{}"));
  } catch {
    return null;
  }
}

function parseCurrentPullRequestCandidate(
  stdout: string,
  fallbackHeadRefName: string,
): ResolvedPullRequestCandidate | null {
  const item = CurrentPullRequestStatusSchema.parse(JSON.parse(stdout || "{}"));
  return toCurrentPullRequestCandidate(item, fallbackHeadRefName);
}

function parseCurrentPullRequestCandidateList(
  stdout: string,
  fallbackHeadRefName: string,
): ResolvedPullRequestCandidate[] {
  const items = z.array(CurrentPullRequestStatusSchema).parse(JSON.parse(stdout || "[]"));
  return items
    .map((item) => toCurrentPullRequestCandidate(item, fallbackHeadRefName))
    .filter((candidate): candidate is ResolvedPullRequestCandidate => candidate !== null);
}

function toCurrentPullRequestCandidate(
  item: CurrentPullRequestStatusItem,
  fallbackHeadRefName: string,
): ResolvedPullRequestCandidate | null {
  const status = toCurrentPullRequestStatus(item, fallbackHeadRefName);
  if (!status) {
    return null;
  }
  const headRepositoryOwner = item.headRepositoryOwner?.login;
  return {
    status,
    ...(headRepositoryOwner ? { headRepositoryOwner } : {}),
  };
}

function isCandidateForHeadRef(candidate: ResolvedPullRequestCandidate, headRef: string): boolean {
  return candidate.status.headRefName === headRef && hasResolvedRepoIdentity(candidate.status);
}

function hasResolvedRepoIdentity(status: GitHubCurrentPullRequestStatus): boolean {
  return Boolean(status.repoOwner && status.repoName);
}

function pickPullRequestCandidate(options: {
  candidates: ResolvedPullRequestCandidate[];
  headRef: string;
  headRepositoryOwner?: string;
}): ResolvedPullRequestCandidate | null {
  const matching = options.candidates.filter((candidate) => {
    if (!isCandidateForHeadRef(candidate, options.headRef)) {
      return false;
    }
    if (!options.headRepositoryOwner) {
      return true;
    }
    return candidate.headRepositoryOwner === options.headRepositoryOwner;
  });
  matching.sort(comparePullRequestCandidatePreference);
  return matching[0] ?? null;
}

function comparePullRequestCandidatePreference(
  left: ResolvedPullRequestCandidate,
  right: ResolvedPullRequestCandidate,
): number {
  return getPullRequestStateRank(left.status) - getPullRequestStateRank(right.status);
}

function getPullRequestStateRank(status: GitHubCurrentPullRequestStatus): number {
  if (status.state === "open" || status.isDraft) {
    return 0;
  }
  if (status.state === "merged") {
    return 1;
  }
  return 2;
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
    updatedAt: item.updatedAt,
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
    updatedAt: item.updatedAt,
  }));
}

function parsePullRequestTimeline(
  stdout: string,
  identity: { prNumber: number; repoOwner: string; repoName: string },
): GitHubPullRequestTimeline {
  const parsed = PullRequestTimelineGraphqlSchema.parse(JSON.parse(stdout || "{}"));
  const pullRequest = parsed.data?.repository?.pullRequest;
  const items = pullRequest
    ? [
        ...pullRequest.reviews.nodes.flatMap(toPullRequestTimelineReviewItem),
        ...pullRequest.comments.nodes.map(toPullRequestTimelineCommentItem),
      ].sort(compareTimelineItems)
    : [];
  return {
    prNumber: pullRequest?.number ?? identity.prNumber,
    repoOwner: identity.repoOwner,
    repoName: identity.repoName,
    items,
    // S3 deliberately caps timeline fetches at the first 100 reviews and first 100 comments.
    truncated: Boolean(
      pullRequest?.reviews.pageInfo.hasNextPage || pullRequest?.comments.pageInfo.hasNextPage,
    ),
    error: pullRequest ? null : { kind: "not_found", message: "Pull request not found" },
  };
}

function toPullRequestTimelineReviewItem(
  review: z.infer<typeof PullRequestTimelineReviewNodeSchema>,
): PullRequestTimelineItem[] {
  const reviewState = mapTimelineReviewState(review.state, review.body ?? "");
  if (!reviewState) {
    return [];
  }
  return [
    {
      kind: "review",
      id: review.id,
      author: review.author?.login ?? "unknown",
      authorUrl: review.author?.url ?? null,
      body: review.body ?? "",
      createdAt: parseOptionalTime(review.submittedAt ?? null),
      url: review.url,
      reviewState,
    },
  ];
}

function toPullRequestTimelineCommentItem(
  comment: z.infer<typeof PullRequestTimelineCommentNodeSchema>,
): PullRequestTimelineItem {
  return {
    kind: "comment",
    id: comment.id,
    author: comment.author?.login ?? "unknown",
    authorUrl: comment.author?.url ?? null,
    body: comment.body ?? "",
    createdAt: parseOptionalTime(comment.createdAt ?? null),
    url: comment.url,
  };
}

function mapTimelineReviewState(
  state: string,
  body: string,
): PullRequestTimelineReviewState | null {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
    case "PENDING":
      return body.trim().length > 0 ? "commented" : null;
    default:
      return body.trim().length > 0 ? "commented" : null;
  }
}

function compareTimelineItems(
  left: PullRequestTimelineItem,
  right: PullRequestTimelineItem,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}

function mapPullRequestTimelineError(error: unknown): GitHubPullRequestTimelineError {
  if (error instanceof GitHubCommandError) {
    return {
      kind: classifyPullRequestTimelineError(error.stderr),
      message: error.stderr || error.message,
    };
  }
  if (error instanceof GitHubAuthenticationError) {
    return {
      kind: "forbidden",
      message: error.stderr || error.message,
    };
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

function classifyPullRequestTimelineError(stderr: string): GitHubPullRequestTimelineErrorKind {
  const normalized = stderr.toLowerCase();
  if (
    normalized.includes("could not resolve to a pullrequest") ||
    normalized.includes("pull request not found") ||
    normalized.includes("pullrequest not found")
  ) {
    return "not_found";
  }
  if (
    normalized.includes("forbidden") ||
    normalized.includes("resource not accessible") ||
    normalized.includes("permission") ||
    normalized.includes("access denied") ||
    normalized.includes("requires authentication") ||
    normalized.includes("http 403")
  ) {
    return "forbidden";
  }
  return "unknown";
}

function toCurrentPullRequestStatus(
  item: CurrentPullRequestStatusItem,
  fallbackHeadRefName: string,
): GitHubCurrentPullRequestStatus | null {
  if (!item.url || !item.title) {
    return null;
  }
  const repoIdentity = parseGitHubPullRequestRepo(item.url);
  const mergedAt =
    typeof item.mergedAt === "string" && item.mergedAt.trim().length > 0 ? item.mergedAt : null;
  const state =
    mergedAt !== null ? "merged" : item.state.trim().length > 0 ? item.state.toLowerCase() : "";
  const checks = parseStatusCheckRollup(item.statusCheckRollup);
  return {
    ...(typeof item.number === "number" ? { number: item.number } : {}),
    ...(repoIdentity ? { repoOwner: repoIdentity.owner, repoName: repoIdentity.name } : {}),
    url: item.url,
    title: item.title,
    state,
    baseRefName: item.baseRefName,
    headRefName: item.headRefName || fallbackHeadRefName,
    isMerged: mergedAt !== null,
    isDraft: item.isDraft ?? false,
    checks,
    checksStatus: computeChecksStatus(checks),
    reviewDecision: mapReviewDecision(item.reviewDecision),
  };
}

function parseGitHubPullRequestRepo(url: string): { owner: string; name: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") {
      return null;
    }
    const [owner, name, kind] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !name || kind !== "pull") {
      return null;
    }
    return { owner, name };
  } catch {
    return null;
  }
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
      ...(typeof context.workflowName === "string" && context.workflowName.trim().length > 0
        ? { workflow: context.workflowName }
        : {}),
      ...formatCheckRunDuration(context),
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

function formatCheckRunDuration(context: PullRequestCheckRunNode): { duration?: string } {
  const startedAt = parseOptionalTime(context.startedAt ?? null);
  const completedAt = parseOptionalTime(context.completedAt ?? null);
  if (startedAt <= 0 || completedAt <= 0 || completedAt < startedAt) {
    return {};
  }
  const durationSeconds = Math.floor((completedAt - startedAt) / 1_000);
  return { duration: formatDurationSeconds(durationSeconds) };
}

function formatDurationSeconds(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(" ");
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

export interface GitHubRepoRemoteUrlResolver {
  resolveRepoRemoteUrl(cwd: string, options?: GitHubReadOptions): Promise<string | null>;
}

export async function resolveGitHubRepo(
  cwd: string,
  options: { workspaceGitService: GitHubRepoRemoteUrlResolver; readOptions?: GitHubReadOptions },
): Promise<string | null> {
  try {
    const remoteUrl = await options.workspaceGitService.resolveRepoRemoteUrl(
      cwd,
      options.readOptions,
    );
    return parseGitHubRepoFromRemote(remoteUrl?.trim() ?? "");
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
