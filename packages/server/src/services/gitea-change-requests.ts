import pLimit from "p-limit";
import { z } from "zod";
import { normalizeHost } from "@getpaseo/protocol/git-remote";
import {
  ChangeRequestRateLimitError,
  createPerHostChangeRequestPoller,
  type PerHostReadContext,
  parseCliHttpResponse,
  parseRetryAfterMs,
} from "./change-request-poller.js";
import type { ChangeRequestSnapshot, ChangeRequestSource } from "./change-request-source.js";
import {
  findTeaLoginNameForBaseUrl,
  getGiteaActionTaskName,
  GITEA_ACTION_MAX_PAGES,
  GITEA_ACTION_PAGE_LIMIT,
  GiteaActionsListResponseSchema,
  GiteaCombinedCommitStatusSchema,
  latestGiteaActionTasksByWorkflow,
  parseGiteaActionTasks,
  type GiteaActionTask,
  type GiteaCommitStatus,
} from "./gitea-checks.js";

const GITEA_CLOUD_HOSTS = new Set(["gitea.com", "codeberg.org"]);
const GITEA_PR_TABS = new Set(["commits", "files", "checks"]);
const GITEA_PAGE_SIZE = GITEA_ACTION_PAGE_LIMIT;
const GITEA_REVIEW_COMMENT_CONCURRENCY = 3;
const GITEA_REVIEW_COMMENTS_TTL_MS = 5 * 60_000;
const GITEA_ACTION_RUN_LOOKUP_LIMIT = 5;

const checkUrlSchema = z.url({ protocol: /^https?$/ });

const giteaWatchPrSchema = z
  .object({
    number: z.number(),
    state: z.string(),
    merged: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    html_url: z.string().optional(),
    head: z
      .object({
        sha: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const giteaIssueCommentSchema = z
  .object({
    id: z.number(),
    html_url: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

const giteaReviewSchema = z
  .object({
    id: z.number(),
    state: z.string(),
    comments_count: z.number().optional().default(0),
    submitted_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    html_url: z.string().optional(),
  })
  .passthrough();

const giteaReviewCommentSchema = z
  .object({
    id: z.number(),
    html_url: z.string().optional(),
  })
  .passthrough();

const giteaActionJobSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
});

const giteaActionJobsPageSchema = z.union([
  z.object({
    jobs: z
      .array(giteaActionJobSchema)
      .nullable()
      .transform((jobs) => jobs ?? []),
    total_count: z.number(),
  }),
  // Forgejo returns the complete job list as an array.
  z.array(giteaActionJobSchema),
]);

type GiteaActionJob = z.infer<typeof giteaActionJobSchema>;

type GiteaWatchPr = z.infer<typeof giteaWatchPrSchema>;
type GiteaReview = z.infer<typeof giteaReviewSchema>;

interface GiteaPullRequestIdentity {
  baseUrl: string;
  displayBase: string | null;
  owner: string;
  repo: string;
  number: number;
}

function invalidGiteaUrl(): never {
  throw new Error("Enter a Gitea, Forgejo, or Codeberg pull request URL.");
}

function parseGiteaUrlOrigin(input: string): {
  protocol: "http:" | "https:";
  host: string;
  port: string;
  hostWithPort: string;
  pathname: string;
} {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) invalidGiteaUrl();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    invalidGiteaUrl();
  }
  const protocol = parsed.protocol.toLowerCase();
  if ((protocol !== "https:" && protocol !== "http:") || parsed.username || parsed.password) {
    invalidGiteaUrl();
  }
  const host = normalizeHost(parsed.hostname);
  if (!host || (GITEA_CLOUD_HOSTS.has(host) && protocol !== "https:")) {
    invalidGiteaUrl();
  }
  return {
    protocol: protocol as "http:" | "https:",
    host,
    port: parsed.port,
    hostWithPort: parsed.port ? `${host}:${parsed.port}` : host,
    pathname: parsed.pathname,
  };
}

function decodeRepoSegment(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    invalidGiteaUrl();
  }
  if (
    !decoded ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\")
  ) {
    invalidGiteaUrl();
  }
  return decoded;
}

function parseGiteaPullRequestUrl(input: string): GiteaPullRequestIdentity {
  const origin = parseGiteaUrlOrigin(input);
  const segments = origin.pathname.split("/").filter(Boolean);

  if (
    segments.length >= 5 &&
    GITEA_PR_TABS.has(segments.at(-1)!.toLowerCase()) &&
    /^\d+$/.test(segments.at(-2)!)
  ) {
    segments.pop();
  }

  const rawNumber = segments.pop();
  const number = Number(rawNumber);
  const resource = segments.pop();
  const repo = segments.pop();
  const owner = segments.pop();
  if (
    resource?.toLowerCase() !== "pulls" ||
    !owner ||
    !repo ||
    !rawNumber ||
    !/^\d+$/.test(rawNumber) ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > 2_147_483_647
  ) {
    invalidGiteaUrl();
  }

  const path = segments.length ? `/${segments.join("/")}` : "";
  const displayBase =
    !path && !origin.port && GITEA_CLOUD_HOSTS.has(origin.host)
      ? null
      : `${origin.hostWithPort}${path}`;
  return {
    baseUrl: `${origin.protocol}//${origin.hostWithPort}${path}`,
    displayBase,
    owner: decodeRepoSegment(owner),
    repo: decodeRepoSegment(repo),
    number,
  };
}

export function resolveGiteaChangeRequest(input: string): string {
  const { baseUrl, owner, repo, number } = parseGiteaPullRequestUrl(input);
  return `${baseUrl}/${owner.toLowerCase()}/${repo.toLowerCase()}/pulls/${number}`;
}

export function describeGiteaChangeRequest(url: string): string {
  const { displayBase, owner, repo, number } = parseGiteaPullRequestUrl(url);
  const project = displayBase ? `${displayBase}/${owner}/${repo}` : `${owner}/${repo}`;
  return `${project} #${number}`;
}

function mapGiteaPrState(pr: GiteaWatchPr): ChangeRequestSnapshot["state"] {
  if (pr.merged === true || pr.merged_at != null) return "merged";
  const normalized = pr.state.toLowerCase();
  if (normalized === "open") return "open";
  if (normalized === "merged") return "merged";
  return "closed";
}

function mapCommitStatusToWatchState(
  status: string,
): ChangeRequestSnapshot["checks"][number]["state"] {
  switch (status.toLowerCase()) {
    case "success":
      return "passed";
    case "failure":
    case "error":
    case "warning":
      return "failed";
    case "pending":
    case "running":
      return "pending";
    default:
      return "neutral";
  }
}

function isCanceledActionStatus(status: GiteaCommitStatus): boolean {
  // Actions writes a generic failure state on cancellation, with a distinct
  // description in the native job's commit status.
  const description = status.description ?? "";
  return description === "Has been cancelled" || description.startsWith("Canceled after ");
}

function mapActionTaskToWatchState(
  status: string,
): ChangeRequestSnapshot["checks"][number]["state"] {
  switch (status.toLowerCase()) {
    case "success":
      return "passed";
    case "failure":
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "skipped":
      return "neutral";
    default:
      return "pending";
  }
}

function computeAggregateChecksState(
  checks: ChangeRequestSnapshot["checks"],
): ChangeRequestSnapshot["checksState"] {
  if (checks.length === 0) return "neutral";
  if (checks.some((check) => check.state === "failed")) return "failed";
  if (checks.some((check) => check.state === "pending")) return "pending";
  if (checks.some((check) => check.state === "passed")) return "passed";
  return "neutral";
}

function nativeActionUrl(value: string | null | undefined, origin: string) {
  if (!value) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return null;
    const match = /^(.*\/actions\/runs\/(\d+))(\/jobs\/\d+)?\/?$/.exec(url.pathname);
    if (!match) return null;
    const [, run, runId, job] = match;
    return { run: run!, runId: runId!, jobUrl: job ? `${origin}${run}${job}` : null };
  } catch {
    return null;
  }
}

function combineWatchChecks(
  commitStatuses: GiteaCommitStatus[],
  actionTasks: GiteaActionTask[],
  jobsByRun: ReadonlyMap<string, GiteaActionJob[]>,
  origin: string,
): ChangeRequestSnapshot["checks"] {
  const checks: ChangeRequestSnapshot["checks"] = [];
  const actionJobs = [...jobsByRun.values()].flat();
  const coveredJobUrls = new Set(
    actionJobs.map((job) => nativeActionUrl(job.html_url, origin)?.jobUrl),
  );

  for (const status of commitStatuses) {
    const jobUrl = nativeActionUrl(status.target_url, origin)?.jobUrl;
    if (jobUrl && coveredJobUrls.has(jobUrl)) continue;
    const url = checkUrlSchema.safeParse(status.target_url).data;
    checks.push({
      id: `status:${status.id}`,
      name: status.context || `status-${status.id}`,
      state:
        jobUrl && isCanceledActionStatus(status)
          ? "neutral"
          : mapCommitStatusToWatchState(status.status),
      ...(url ? { url } : {}),
    });
  }

  for (const job of actionJobs) {
    const url = checkUrlSchema.safeParse(job.html_url).data;
    checks.push({
      id: `action-job:${job.id}`,
      name: job.name,
      state: mapActionTaskToWatchState(job.conclusion || job.status),
      ...(url ? { url } : {}),
    });
  }

  const seenTaskIds = new Set<number>();
  for (const task of actionTasks) {
    if (seenTaskIds.has(task.id)) continue;
    const address = nativeActionUrl(task.url, origin);
    if (address && jobsByRun.has(address.run)) continue;
    seenTaskIds.add(task.id);
    const url = checkUrlSchema.safeParse(task.url).data;
    checks.push({
      id: `action:${task.id}`,
      name: getGiteaActionTaskName(task),
      state: mapActionTaskToWatchState(task.status),
      ...(url ? { url } : {}),
    });
  }

  return checks;
}

function hasNextLinkHeader(headers: ReadonlyMap<string, string>): boolean {
  const link = headers.get("link");
  return link ? /rel=["']?next["']?/i.test(link) : false;
}

function parseTotalCountHeader(headers: ReadonlyMap<string, string>): number | null {
  const raw = headers.get("x-total-count");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isSubmittedGiteaReview(review: GiteaReview): boolean {
  const state = review.state.trim().toUpperCase();
  return state !== "PENDING" && state !== "REQUEST_REVIEW";
}

function parseTeaHttpStreams(
  stdout: string,
  stderr: string,
): {
  status: number | null;
  headers: Map<string, string>;
  body: string;
} {
  const fromStdout = parseCliHttpResponse(stdout);
  if (fromStdout.status !== null) {
    return fromStdout;
  }
  const fromStderr = parseCliHttpResponse(stderr);
  if (fromStderr.status !== null) {
    return { status: fromStderr.status, headers: fromStderr.headers, body: stdout.trim() };
  }
  return { status: null, headers: new Map(), body: stdout.trim() };
}

class TeaHttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TeaHttpStatusError";
    this.status = status;
  }
}

function isOptionalEndpointStatus(error: unknown): boolean {
  return (
    error instanceof TeaHttpStatusError &&
    (error.status === 403 || error.status === 404 || error.status === 501)
  );
}

type TeaApiGet = <T>(
  endpoint: string,
  schema: z.ZodType<T>,
) => Promise<{ data: T; headers: ReadonlyMap<string, string> }>;

interface TeaPollApi {
  get: TeaApiGet;
  all<T extends readonly unknown[]>(
    reads: T,
  ): Promise<{ -readonly [Key in keyof T]: Awaited<T[Key]> }>;
}

interface CachedReviewComments {
  count: number;
  fetchedAt: number;
  items: ChangeRequestSnapshot["activity"];
}

export interface CreateGiteaChangeRequestSourceOptions {
  runCommand(
    args: string[],
    options: { cwd: string; envOverlay?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string }>;
  createAuthError(stderr: string): Error;
  createCommandError(params: {
    args: string[];
    cwd: string;
    exitCode: number | null;
    stderr: string;
    stdout?: string;
  }): Error;
  now?: () => number;
  pollIntervalMs?: number;
  initialDelayMs?: number;
}

export function createGiteaChangeRequestSource(
  options: CreateGiteaChangeRequestSourceOptions,
): ChangeRequestSource & { dispose(): void } {
  const now = options.now ?? Date.now;
  const cachedReviewCommentsByUrl = new Map<string, Map<number, CachedReviewComments>>();
  const reviewCommentLimit = pLimit(GITEA_REVIEW_COMMENT_CONCURRENCY);

  async function resolveLogin(baseUrl: string): Promise<string> {
    const result = await options.runCommand(["login", "list", "-o", "json"], {
      cwd: process.cwd(),
    });
    const loginName = findTeaLoginNameForBaseUrl(result.stdout, baseUrl);
    if (!loginName) {
      throw options.createAuthError(`No tea login configured for ${baseUrl}`);
    }
    return loginName;
  }

  function parseJsonBody<T>(params: {
    args: string[];
    cwd: string;
    body: string;
    schema: z.ZodType<T>;
  }): T {
    let data: unknown;
    try {
      data = JSON.parse(params.body);
    } catch {
      throw options.createCommandError({
        args: params.args,
        cwd: params.cwd,
        exitCode: null,
        stderr: `tea did not return valid JSON (${params.body.length} bytes)`,
      });
    }
    const parsed = params.schema.safeParse(data);
    if (!parsed.success) {
      throw options.createCommandError({
        args: params.args,
        cwd: params.cwd,
        exitCode: null,
        stderr: `tea JSON did not match the expected schema: ${parsed.error.message}`,
      });
    }
    return parsed.data;
  }

  function bindTeaApi(context: PerHostReadContext, loginName: string): TeaPollApi {
    let active = true;

    const get: TeaApiGet = async (endpoint, schema) => {
      if (!active || !context.isObserved()) throw new Error("Change request observation ended");
      context.assertHostAvailable();
      const args = ["api", "--login", loginName, "-i", endpoint];
      const cwd = process.cwd();
      const result = await options.runCommand(args, { cwd });
      const parsed = parseTeaHttpStreams(result.stdout, result.stderr);
      const nowMs = now();

      // tea api can exit 0 on an HTTP failure, so always check the status line.
      if (parsed.status === null) {
        throw options.createCommandError({
          args,
          cwd,
          exitCode: 0,
          stderr: "tea api -i did not return an HTTP status line",
          stdout: result.stdout,
        });
      }
      if (parsed.status === 429) {
        const resetAtMs = parseRetryAfterMs(parsed.headers, nowMs, {
          forceOnMissing: true,
          defaultPauseMs: 60_000,
        })!;
        context.pauseHost(resetAtMs);
        throw new ChangeRequestRateLimitError({ host: context.host, resetAtMs });
      }
      if (parsed.status === 401) {
        throw options.createAuthError(parsed.body || "401 Unauthorized");
      }
      if (parsed.status < 200 || parsed.status >= 300) {
        throw new TeaHttpStatusError(
          parsed.status,
          `Gitea API returned HTTP ${parsed.status} for ${endpoint}: ${parsed.body}`.trim(),
        );
      }

      const proactivePause = parseRetryAfterMs(parsed.headers, nowMs);
      if (proactivePause !== null) context.deferPollsUntil(proactivePause);

      const data = parseJsonBody({ args, cwd, body: parsed.body, schema });
      return { data, headers: parsed.headers };
    };

    return {
      get,
      all(reads) {
        return Promise.all(reads).catch(async (error: unknown) => {
          // Stop admitting reads from this poll and hold its host slot until
          // requests already sent (including late rate limits) settle.
          active = false;
          await Promise.allSettled(reads);
          throw error;
        });
      },
    };
  }

  async function teaApiGetAllPages<T>(params: {
    get: TeaApiGet;
    endpoint: string;
    itemSchema: z.ZodType<T>;
  }): Promise<T[]> {
    const items: T[] = [];
    const schema = z.array(params.itemSchema);
    let minPageSize = 1;
    for (let page = 1; ; page += 1) {
      const sep = params.endpoint.includes("?") ? "&" : "?";
      const { data, headers } = await params.get(
        `${params.endpoint}${sep}page=${page}&limit=${GITEA_PAGE_SIZE}`,
        schema,
      );
      items.push(...data);
      if (headers.has("link")) {
        if (hasNextLinkHeader(headers)) continue;
        break;
      }

      const totalCount = parseTotalCountHeader(headers);
      if (totalCount !== null) {
        // Gitea can cap limit below the requested value and filter pending
        // reviews after pagination. The largest page is a lower bound on
        // the number of records advanced on every page.
        minPageSize = Math.max(minPageSize, data.length);
        if (page * minPageSize < totalCount) continue;
        break;
      }
      if (data.length < GITEA_PAGE_SIZE) break;
    }

    return items;
  }

  async function readCommitStatuses(params: {
    get: TeaApiGet;
    repoPrefix: string;
    headSha: string;
    isObserved(): boolean;
  }): Promise<{ statuses: GiteaCommitStatus[]; pagesRead: number }> {
    const statuses: GiteaCommitStatus[] = [];
    const seenIds = new Set<number>();
    let page = 1;
    let pagesRead = 0;

    while (true) {
      if (!params.isObserved()) return { statuses, pagesRead };
      const response = await params.get(
        `${params.repoPrefix}/commits/${encodeURIComponent(params.headSha)}/status?limit=${GITEA_PAGE_SIZE}&page=${page}`,
        GiteaCombinedCommitStatusSchema,
      );
      pagesRead += 1;
      const pageStatuses = response.data.statuses;
      if (pageStatuses.length === 0) break;
      for (const status of pageStatuses) {
        if (seenIds.has(status.id)) {
          throw new Error("Gitea commit status pages overlap. Retry the poll.");
        }
        seenIds.add(status.id);
        statuses.push(status);
      }

      // Gitea sets body `total_count` to the current page length; the full total
      // lives only in the `X-Total-Count` response header.
      const headerTotal = parseTotalCountHeader(response.headers);
      if (headerTotal !== null) {
        if (statuses.length >= headerTotal) break;
        page += 1;
        continue;
      }
      if (hasNextLinkHeader(response.headers) || pageStatuses.length >= GITEA_PAGE_SIZE) {
        page += 1;
        continue;
      }
      break;
    }

    return { statuses, pagesRead };
  }

  async function readBoundedActionTasks(params: {
    get: TeaApiGet;
    repoPrefix: string;
    isObserved(): boolean;
  }): Promise<{ items: unknown[]; pagesRead: number }> {
    const items: unknown[] = [];
    let fetched = 0;
    let pagesRead = 0;

    for (let page = 1; page <= GITEA_ACTION_MAX_PAGES; page += 1) {
      if (!params.isObserved()) return { items, pagesRead };
      let response: { data: z.infer<typeof GiteaActionsListResponseSchema> };
      try {
        response = await params.get(
          `${params.repoPrefix}/actions/tasks?limit=${GITEA_PAGE_SIZE}&page=${page}`,
          GiteaActionsListResponseSchema,
        );
      } catch (error) {
        if (page === 1 && isOptionalEndpointStatus(error)) {
          return { items: [], pagesRead: 0 };
        }
        throw error;
      }
      pagesRead += 1;
      const runs = response.data.workflow_runs;
      if (runs.length === 0) break;
      fetched += runs.length;
      items.push(...runs);
      if (response.data.total_count !== undefined && fetched >= response.data.total_count) break;
    }

    return { items, pagesRead };
  }

  async function readActionJobs(params: {
    get: TeaApiGet;
    origin: string;
    repoPrefix: string;
    tasks: GiteaActionTask[];
    statuses: GiteaCommitStatus[];
  }): Promise<Map<string, GiteaActionJob[]>> {
    // Commit statuses identify a job URL. Tasks identify a run, so only a job
    // list can establish coverage when both sources report the same run.
    const statusRuns = new Set<string>();
    for (const status of params.statuses) {
      const address = nativeActionUrl(status.target_url, params.origin);
      if (address?.jobUrl) statusRuns.add(address.run);
    }
    const runs = new Map<string, string>();
    for (const task of params.tasks) {
      const address = nativeActionUrl(task.url, params.origin);
      if (address && statusRuns.has(address.run)) runs.set(address.run, address.runId);
    }
    const jobsByRun = new Map<string, GiteaActionJob[]>();
    for (const [run, runId] of [...runs].slice(0, GITEA_ACTION_RUN_LOOKUP_LIMIT)) {
      const endpoint = `${params.repoPrefix}/actions/runs/${runId}/jobs`;
      const jobs = new Map<number, GiteaActionJob>();
      for (let page = 1; page <= GITEA_ACTION_MAX_PAGES; page += 1) {
        try {
          const { data } = await params.get(
            `${endpoint}?limit=${GITEA_PAGE_SIZE}&page=${page}`,
            giteaActionJobsPageSchema,
          );
          const items = Array.isArray(data) ? data : data.jobs;
          const totalCount = Array.isArray(data) ? data.length : data.total_count;
          if (!items.length) break;
          // The browser run number and API ID differ on some versions. Keep
          // the original sources if any job belongs to another run.
          if (items.some((job) => nativeActionUrl(job.html_url, params.origin)?.run !== run)) {
            break;
          }
          for (const job of items) jobs.set(job.id, job);
          if (jobs.size >= totalCount) {
            jobsByRun.set(run, [...jobs.values()]);
            break;
          }
        } catch (error) {
          if (page === 1 && isOptionalEndpointStatus(error)) break;
          throw error;
        }
      }
    }
    return jobsByRun;
  }

  async function readChecks(params: {
    api: TeaPollApi;
    origin: string;
    repoPrefix: string;
    prEndpoint: string;
    headSha: string;
    isObserved(): boolean;
  }): Promise<ChangeRequestSnapshot["checks"]> {
    const { get, all } = params.api;
    const [statusResult, tasksResult] = await all([
      readCommitStatuses({ ...params, get }),
      readBoundedActionTasks({ ...params, get }),
    ]);
    if (!params.isObserved()) {
      throw new Error("Change request observation ended");
    }

    const matchingTasks = parseGiteaActionTasks(tasksResult.items).filter(
      (task) => task.head_sha === params.headSha,
    );
    const latestTasks = latestGiteaActionTasksByWorkflow(matchingTasks);

    const jobsByRun = await readActionJobs({
      ...params,
      get,
      tasks: latestTasks,
      statuses: statusResult.statuses,
    });
    if (statusResult.pagesRead > 1 || tasksResult.pagesRead > 1 || jobsByRun.size > 0) {
      const { data: recheck } = await get(params.prEndpoint, giteaWatchPrSchema);
      if (recheck.head.sha !== params.headSha) {
        throw new Error("The pull request head changed during pagination.");
      }
    }

    return combineWatchChecks(statusResult.statuses, latestTasks, jobsByRun, params.origin);
  }

  async function readActivity(params: {
    url: string;
    api: TeaPollApi;
    repoPrefix: string;
    number: number;
    prWebUrl: string;
    terminal: boolean;
    knownActivity(): ReadonlySet<string> | undefined;
    isObserved(): boolean;
  }): Promise<ChangeRequestSnapshot["activity"]> {
    const { get, all } = params.api;
    const [comments, reviews] = await all([
      teaApiGetAllPages({
        get,
        endpoint: `${params.repoPrefix}/issues/${params.number}/comments`,
        itemSchema: giteaIssueCommentSchema,
      }),
      teaApiGetAllPages({
        get,
        endpoint: `${params.repoPrefix}/pulls/${params.number}/reviews`,
        itemSchema: giteaReviewSchema,
      }),
    ]);
    if (!params.isObserved()) {
      throw new Error("Change request observation ended");
    }

    const activity: ChangeRequestSnapshot["activity"] = [];
    for (const comment of comments) {
      if (comment.type !== undefined && comment.type !== "comment") continue;
      activity.push({
        id: `comment:${comment.id}`,
        kind: "comment",
        url: comment.html_url || `${params.prWebUrl}#issuecomment-${comment.id}`,
      });
    }

    const submittedReviews = reviews.filter(isSubmittedGiteaReview);
    for (const review of submittedReviews) {
      activity.push({
        id: `review:${review.id}`,
        kind: "review",
        url: review.html_url || `${params.prWebUrl}#pullrequestreview-${review.id}`,
      });
    }

    const known = params.knownActivity();
    let reviewCache = cachedReviewCommentsByUrl.get(params.url);
    if (!reviewCache) {
      reviewCache = new Map<number, CachedReviewComments>();
      cachedReviewCommentsByUrl.set(params.url, reviewCache);
    }

    const staleBefore = now() - GITEA_REVIEW_COMMENTS_TTL_MS;
    const reviewsNeedingFetch = submittedReviews.filter((review) => {
      if (review.comments_count <= 0) return false;
      const cached = reviewCache.get(review.id);
      if (
        !params.terminal &&
        cached &&
        cached.fetchedAt > staleBefore &&
        cached.count === review.comments_count &&
        cached.items.every((item) => known?.has(item.id))
      ) {
        return false;
      }
      return true;
    });

    // Gitea's review-comments endpoint returns all comments for a review in one
    // response and ignores page/limit, so fetch it once without a pagination loop.
    const fetchedGroups = await all(
      reviewsNeedingFetch.map((review) =>
        reviewCommentLimit(async () => {
          if (!params.isObserved()) {
            return { reviewId: review.id, count: review.comments_count, items: [] };
          }
          const { data: inlineComments } = await get(
            `${params.repoPrefix}/pulls/${params.number}/reviews/${review.id}/comments`,
            z.array(giteaReviewCommentSchema),
          );
          const items: ChangeRequestSnapshot["activity"] = inlineComments.map((comment) => ({
            id: `inline:${comment.id}`,
            kind: "inline comment",
            url: comment.html_url || `${params.prWebUrl}#issuecomment-${comment.id}`,
          }));
          return { reviewId: review.id, count: review.comments_count, items };
        }),
      ),
    );
    if (!params.isObserved()) {
      throw new Error("Change request observation ended");
    }

    const fetchedAt = now();
    for (const group of fetchedGroups) {
      reviewCache.set(group.reviewId, { count: group.count, fetchedAt, items: group.items });
    }
    for (const review of submittedReviews) {
      if (review.comments_count <= 0) continue;
      const cached = reviewCache.get(review.id);
      if (cached) {
        activity.push(...cached.items);
      }
    }

    return activity;
  }

  async function readPullRequest(context: PerHostReadContext): Promise<ChangeRequestSnapshot> {
    const identity = parseGiteaPullRequestUrl(context.url);
    const { baseUrl, owner, repo, number } = identity;
    const loginName = await resolveLogin(baseUrl);
    const api = bindTeaApi(context, loginName);
    const repoPrefix = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const prEndpoint = `${repoPrefix}/pulls/${number}`;

    const { data: pr } = await api.get(prEndpoint, giteaWatchPrSchema);
    if (!pr.head.sha) {
      throw new Error(`Gitea pull request #${number} did not include a head commit SHA.`);
    }
    const prWebUrl = pr.html_url || context.url;
    const address = parseGiteaPullRequestUrl(prWebUrl);
    if (
      address.baseUrl !== baseUrl ||
      address.owner.toLowerCase() !== owner.toLowerCase() ||
      address.repo.toLowerCase() !== repo.toLowerCase() ||
      address.number !== number ||
      pr.number !== number
    ) {
      throw new Error("Tea returned a pull request that does not match the watch URL.");
    }

    const checks = await readChecks({
      api,
      origin: context.host,
      repoPrefix,
      prEndpoint,
      headSha: pr.head.sha,
      isObserved: context.isObserved,
    });
    const state = mapGiteaPrState(pr);
    const activity = await readActivity({
      url: context.url,
      api,
      repoPrefix,
      number,
      prWebUrl,
      terminal: state !== "open",
      knownActivity: context.knownActivity,
      isObserved: context.isObserved,
    });

    return {
      state,
      headSha: pr.head.sha,
      checksState: computeAggregateChecksState(checks),
      checks,
      reviewDecision: null,
      activity,
    };
  }

  const poller = createPerHostChangeRequestPoller({
    hostOf: (url) => new URL(url).origin,
    read: readPullRequest,
    now,
    pollIntervalMs: options.pollIntervalMs,
    initialDelayMs: options.initialDelayMs,
  });

  return {
    resolve: resolveGiteaChangeRequest,
    describe: describeGiteaChangeRequest,
    observe(url, callbacks) {
      const release = poller.observe(url, callbacks);
      return () => {
        cachedReviewCommentsByUrl.delete(url);
        release();
      };
    },
    dispose() {
      cachedReviewCommentsByUrl.clear();
      poller.dispose();
    },
  };
}
