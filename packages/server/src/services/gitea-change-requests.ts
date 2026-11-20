import pLimit from "p-limit";
import { z } from "zod";
import { normalizeHost } from "@getpaseo/protocol/git-remote";
import {
  ChangeRequestRateLimitError,
  createPerHostChangeRequestPoller,
  parseCliHttpResponse,
  parseRetryAfterMs,
} from "./change-request-poller.js";
import type { ChangeRequestSnapshot, ChangeRequestSource } from "./change-request-source.js";
import {
  findTeaLoginNameForHost,
  getGiteaActionRunIdFromUrl,
  getGiteaActionTaskName,
  getUrlOrigin,
  GITEA_ACTION_MAX_PAGES,
  GITEA_ACTION_PAGE_LIMIT,
  GiteaActionsListResponseSchema,
  GiteaCombinedCommitStatusSchema,
  isGiteaActionShadowStatus,
  latestGiteaActionTasksByWorkflow,
  parseGiteaActionTasks,
  type GiteaActionTask,
  type GiteaCommitStatus,
} from "./gitea-checks.js";

const GITEA_CLOUD_HOSTS = new Set(["gitea.com", "codeberg.org"]);
const GITEA_PR_TABS = new Set(["commits", "files", "checks"]);
const GITEA_PAGE_SIZE = GITEA_ACTION_PAGE_LIMIT;
const GITEA_REVIEW_COMMENT_CONCURRENCY = 3;

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

type GiteaWatchPr = z.infer<typeof giteaWatchPrSchema>;
type GiteaReview = z.infer<typeof giteaReviewSchema>;

interface GiteaPullRequestIdentity {
  protocol: "http:" | "https:";
  host: string;
  port: string;
  hostWithPort: string;
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
  const segments = origin.pathname.split("/").filter((segment) => segment.length > 0);

  if (
    segments.length === 5 &&
    GITEA_PR_TABS.has(segments[4]!.toLowerCase()) &&
    /^\d+$/.test(segments[3]!)
  ) {
    segments.pop();
  }

  if (
    segments.length !== 4 ||
    segments[2]!.toLowerCase() !== "pulls" ||
    !/^\d+$/.test(segments[3]!)
  ) {
    invalidGiteaUrl();
  }
  const number = Number(segments[3]!);
  if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) {
    invalidGiteaUrl();
  }

  return {
    protocol: origin.protocol,
    host: origin.host,
    port: origin.port,
    hostWithPort: origin.hostWithPort,
    owner: decodeRepoSegment(segments[0]!),
    repo: decodeRepoSegment(segments[1]!),
    number,
  };
}

export function resolveGiteaChangeRequest(input: string): string {
  const { protocol, hostWithPort, owner, repo, number } = parseGiteaPullRequestUrl(input);
  return `${protocol}//${hostWithPort}/${owner}/${repo}/pulls/${number}`;
}

export function giteaChangeRequestHost(url: string): string {
  return parseGiteaPullRequestUrl(url).hostWithPort;
}

export function describeGiteaChangeRequest(url: string): string {
  const { host, port, hostWithPort, owner, repo, number } = parseGiteaPullRequestUrl(url);
  const project =
    !port && GITEA_CLOUD_HOSTS.has(host) ? `${owner}/${repo}` : `${hostWithPort}/${owner}/${repo}`;
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

function combineWatchChecks(
  commitStatuses: GiteaCommitStatus[],
  actionTasks: GiteaActionTask[],
): ChangeRequestSnapshot["checks"] {
  const nativeOrigins = new Set(
    actionTasks
      .map((task) => getUrlOrigin(task.url))
      .filter((origin): origin is string => Boolean(origin)),
  );
  const nativeRunIds = new Set(
    actionTasks
      .map((task) => getGiteaActionRunIdFromUrl(task.url))
      .filter((runId): runId is number => runId !== null),
  );
  const checks: ChangeRequestSnapshot["checks"] = [];
  const seenStatusIds = new Set<number>();

  for (const status of commitStatuses) {
    if (seenStatusIds.has(status.id)) continue;
    seenStatusIds.add(status.id);
    if (isGiteaActionShadowStatus(status, nativeOrigins, nativeRunIds)) continue;
    const url = checkUrlSchema.safeParse(status.target_url).data;
    checks.push({
      id: `status:${status.id}`,
      name: status.context || `status-${status.id}`,
      state: mapCommitStatusToWatchState(status.status),
      ...(url ? { url } : {}),
    });
  }

  const seenTaskIds = new Set<number>();
  for (const task of actionTasks) {
    if (seenTaskIds.has(task.id)) continue;
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

interface CachedReviewComments {
  count: number;
  items: ChangeRequestSnapshot["activity"];
}

export interface CreateGiteaChangeRequestSourceOptions {
  runCommand(
    args: string[],
    options: { cwd: string; envOverlay?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string }>;
  isAuthError(error: unknown): boolean;
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
  const loginByHost = new Map<string, string>();
  const cachedReviewCommentsByUrl = new Map<string, Map<number, CachedReviewComments>>();
  const reviewCommentLimit = pLimit(GITEA_REVIEW_COMMENT_CONCURRENCY);

  async function resolveLogin(hostWithPort: string, host: string): Promise<string> {
    const cached = loginByHost.get(hostWithPort);
    if (cached) return cached;

    const result = await options.runCommand(["login", "list", "-o", "json"], {
      cwd: process.cwd(),
    });
    const loginName = findTeaLoginNameForHost(result.stdout, host, hostWithPort);
    if (!loginName) {
      throw options.createAuthError(`No tea login configured for ${hostWithPort}`);
    }
    loginByHost.set(hostWithPort, loginName);
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

  async function teaApiGet<T>(params: {
    hostWithPort: string;
    loginName: string;
    endpoint: string;
    schema: z.ZodType<T>;
    pauseHost(untilMs: number): void;
  }): Promise<{ data: T; headers: ReadonlyMap<string, string> }> {
    const args = ["api", "--login", params.loginName, "-i", params.endpoint];
    const cwd = process.cwd();
    const result = await options.runCommand(args, { cwd });
    const parsed = parseTeaHttpStreams(result.stdout, result.stderr);
    const nowMs = now();

    // tea api exits 0 even on HTTP 4xx/5xx; never trust exit code 0 without a 2xx status line.
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
      throw new ChangeRequestRateLimitError({ host: params.hostWithPort, resetAtMs });
    }
    if (parsed.status === 401) {
      loginByHost.delete(params.hostWithPort);
      throw options.createAuthError(parsed.body || "401 Unauthorized");
    }
    if (parsed.status < 200 || parsed.status >= 300) {
      throw new TeaHttpStatusError(
        parsed.status,
        `Gitea API returned HTTP ${parsed.status} for ${params.endpoint}: ${parsed.body}`.trim(),
      );
    }

    const proactivePause = parseRetryAfterMs(parsed.headers, nowMs);
    if (proactivePause !== null) {
      params.pauseHost(proactivePause);
    }

    const data = parseJsonBody({ args, cwd, body: parsed.body, schema: params.schema });
    return { data, headers: parsed.headers };
  }

  async function teaApiGetAllPages<T>(params: {
    hostWithPort: string;
    loginName: string;
    endpoint: string;
    itemSchema: z.ZodType<T>;
    isObserved(): boolean;
    pauseHost(untilMs: number): void;
  }): Promise<T[]> {
    const items: T[] = [];
    const schema = z.array(params.itemSchema);
    let page = 1;

    while (true) {
      if (!params.isObserved()) return items;
      const sep = params.endpoint.includes("?") ? "&" : "?";
      const response = await teaApiGet({
        hostWithPort: params.hostWithPort,
        loginName: params.loginName,
        endpoint: `${params.endpoint}${sep}page=${page}&limit=${GITEA_PAGE_SIZE}`,
        schema,
        pauseHost: params.pauseHost,
      });
      if (response.data.length === 0) break;
      items.push(...response.data);

      const totalCount = parseTotalCountHeader(response.headers);
      if (totalCount !== null) {
        if (items.length >= totalCount) break;
        page += 1;
        continue;
      }
      if (hasNextLinkHeader(response.headers) || response.data.length >= GITEA_PAGE_SIZE) {
        page += 1;
        continue;
      }
      break;
    }

    return items;
  }

  async function readCommitStatuses(params: {
    hostWithPort: string;
    loginName: string;
    repoPrefix: string;
    headSha: string;
    isObserved(): boolean;
    pauseHost(untilMs: number): void;
  }): Promise<{ statuses: GiteaCommitStatus[]; pagesRead: number }> {
    const statuses: GiteaCommitStatus[] = [];
    let page = 1;
    let pagesRead = 0;

    while (true) {
      if (!params.isObserved()) return { statuses, pagesRead };
      const response = await teaApiGet({
        hostWithPort: params.hostWithPort,
        loginName: params.loginName,
        endpoint: `${params.repoPrefix}/commits/${encodeURIComponent(params.headSha)}/status?limit=${GITEA_PAGE_SIZE}&page=${page}`,
        schema: GiteaCombinedCommitStatusSchema,
        pauseHost: params.pauseHost,
      });
      pagesRead += 1;
      const pageStatuses = response.data.statuses;
      if (pageStatuses.length === 0) break;
      statuses.push(...pageStatuses);

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
    hostWithPort: string;
    loginName: string;
    repoPrefix: string;
    isObserved(): boolean;
    pauseHost(untilMs: number): void;
  }): Promise<{ items: unknown[]; pagesRead: number }> {
    const items: unknown[] = [];
    let fetched = 0;
    let pagesRead = 0;

    for (let page = 1; page <= GITEA_ACTION_MAX_PAGES; page += 1) {
      if (!params.isObserved()) return { items, pagesRead };
      let response: { data: z.infer<typeof GiteaActionsListResponseSchema> };
      try {
        response = await teaApiGet({
          hostWithPort: params.hostWithPort,
          loginName: params.loginName,
          endpoint: `${params.repoPrefix}/actions/tasks?limit=${GITEA_PAGE_SIZE}&page=${page}`,
          schema: GiteaActionsListResponseSchema,
          pauseHost: params.pauseHost,
        });
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

  async function readChecks(params: {
    hostWithPort: string;
    loginName: string;
    repoPrefix: string;
    prEndpoint: string;
    headSha: string;
    isObserved(): boolean;
    pauseHost(untilMs: number): void;
  }): Promise<ChangeRequestSnapshot["checks"]> {
    const [statusResult, tasksResult] = await Promise.all([
      readCommitStatuses(params),
      readBoundedActionTasks(params),
    ]);
    if (!params.isObserved()) {
      throw new Error("Change request observation ended");
    }

    const matchingTasks = parseGiteaActionTasks(tasksResult.items).filter(
      (task) => task.head_sha === params.headSha,
    );
    const latestTasks = latestGiteaActionTasksByWorkflow(matchingTasks);

    if (statusResult.pagesRead > 1 || tasksResult.pagesRead > 1) {
      const { data: recheck } = await teaApiGet({
        hostWithPort: params.hostWithPort,
        loginName: params.loginName,
        endpoint: params.prEndpoint,
        schema: giteaWatchPrSchema,
        pauseHost: params.pauseHost,
      });
      if (recheck.head.sha !== params.headSha) {
        throw new Error("The pull request head changed during pagination.");
      }
    }

    return combineWatchChecks(statusResult.statuses, latestTasks);
  }

  async function readActivity(params: {
    url: string;
    hostWithPort: string;
    loginName: string;
    repoPrefix: string;
    number: number;
    prWebUrl: string;
    knownActivity(): ReadonlySet<string> | undefined;
    isObserved(): boolean;
    pauseHost(untilMs: number): void;
  }): Promise<ChangeRequestSnapshot["activity"]> {
    const [comments, reviews] = await Promise.all([
      teaApiGetAllPages({
        hostWithPort: params.hostWithPort,
        loginName: params.loginName,
        endpoint: `${params.repoPrefix}/issues/${params.number}/comments`,
        itemSchema: giteaIssueCommentSchema,
        isObserved: params.isObserved,
        pauseHost: params.pauseHost,
      }),
      teaApiGetAllPages({
        hostWithPort: params.hostWithPort,
        loginName: params.loginName,
        endpoint: `${params.repoPrefix}/pulls/${params.number}/reviews`,
        itemSchema: giteaReviewSchema,
        isObserved: params.isObserved,
        pauseHost: params.pauseHost,
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

    const reviewsNeedingFetch = submittedReviews.filter((review) => {
      if (review.comments_count <= 0) return false;
      const cached = reviewCache.get(review.id);
      if (
        cached &&
        cached.count === review.comments_count &&
        cached.items.every((item) => known?.has(item.id))
      ) {
        return false;
      }
      return true;
    });

    // Gitea's review-comments endpoint returns all comments for a review in one
    // response and ignores page/limit, so fetch it once without a pagination loop.
    const fetchedGroups = await Promise.all(
      reviewsNeedingFetch.map((review) =>
        reviewCommentLimit(async () => {
          if (!params.isObserved()) {
            return { reviewId: review.id, count: review.comments_count, items: [] };
          }
          const { data: inlineComments } = await teaApiGet({
            hostWithPort: params.hostWithPort,
            loginName: params.loginName,
            endpoint: `${params.repoPrefix}/pulls/${params.number}/reviews/${review.id}/comments`,
            schema: z.array(giteaReviewCommentSchema),
            pauseHost: params.pauseHost,
          });
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

    for (const group of fetchedGroups) {
      reviewCache.set(group.reviewId, { count: group.count, items: group.items });
    }
    for (const review of submittedReviews) {
      const cached = reviewCache.get(review.id);
      if (cached) {
        activity.push(...cached.items);
      }
    }

    return activity;
  }

  async function readPullRequest(context: {
    url: string;
    host: string;
    knownActivity(): ReadonlySet<string> | undefined;
    isObserved(): boolean;
    pauseHost(untilMs: number): void;
  }): Promise<ChangeRequestSnapshot> {
    const { host, hostWithPort, owner, repo, number } = parseGiteaPullRequestUrl(context.url);
    const loginName = await resolveLogin(hostWithPort, host);
    const repoPrefix = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const prEndpoint = `${repoPrefix}/pulls/${number}`;

    const { data: pr } = await teaApiGet({
      hostWithPort,
      loginName,
      endpoint: prEndpoint,
      schema: giteaWatchPrSchema,
      pauseHost: context.pauseHost,
    });
    if (!pr.head.sha) {
      throw new Error(`Gitea pull request #${number} did not include a head commit SHA.`);
    }
    const prWebUrl = pr.html_url || context.url;

    const checks = await readChecks({
      hostWithPort,
      loginName,
      repoPrefix,
      prEndpoint,
      headSha: pr.head.sha,
      isObserved: context.isObserved,
      pauseHost: context.pauseHost,
    });
    const activity = await readActivity({
      url: context.url,
      hostWithPort,
      loginName,
      repoPrefix,
      number,
      prWebUrl,
      knownActivity: context.knownActivity,
      isObserved: context.isObserved,
      pauseHost: context.pauseHost,
    });

    return {
      state: mapGiteaPrState(pr),
      headSha: pr.head.sha,
      checksState: computeAggregateChecksState(checks),
      checks,
      reviewDecision: null,
      activity,
    };
  }

  const poller = createPerHostChangeRequestPoller({
    hostOf: giteaChangeRequestHost,
    read: readPullRequest,
    now,
    pollIntervalMs: options.pollIntervalMs,
    initialDelayMs: options.initialDelayMs,
    onError(error, host) {
      if (options.isAuthError(error)) {
        loginByHost.delete(host);
      }
    },
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
      loginByHost.clear();
      poller.dispose();
    },
  };
}
