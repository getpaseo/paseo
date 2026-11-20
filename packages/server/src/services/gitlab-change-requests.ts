import { z } from "zod";
import { normalizeHost } from "@getpaseo/protocol/git-remote";
import { GITLAB_ACTIVE_PIPELINE_STATUS_SET } from "@getpaseo/protocol/gitlab-pipeline";
import {
  ChangeRequestRateLimitError,
  createPerHostChangeRequestPoller,
  parseCliHttpResponse,
  parseRetryAfterMs,
  type PerHostReadContext,
} from "./change-request-poller.js";
import type { ChangeRequestSnapshot, ChangeRequestSource } from "./change-request-source.js";

const GITLAB_CLOUD_HOST = "gitlab.com";
const GITLAB_PAGE_SIZE = 100;
const GITLAB_MR_TABS = new Set(["diffs", "commits", "pipelines", "builds", "reports"]);

const checkUrlSchema = z.url({ protocol: /^https?$/ });

const gitLabWatchPipelineSchema = z
  .object({
    id: z.number(),
    project_id: z.number().nullable().optional(),
    sha: z.string().nullable().optional(),
    status: z.string(),
    web_url: z.string().nullable().optional(),
  })
  .passthrough();

const gitLabWatchMrSchema = z
  .object({
    iid: z.number(),
    state: z.string(),
    sha: z.string().nullable().optional(),
    diff_refs: z
      .object({
        head_sha: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    web_url: checkUrlSchema,
    target_project_id: z.number().nullable().optional(),
    merged_at: z.string().nullable().optional(),
    head_pipeline: gitLabWatchPipelineSchema.nullable().optional(),
  })
  .passthrough();

const gitLabWatchJobSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    status: z.string(),
    allow_failure: z.boolean().optional(),
    web_url: z.string().nullable().optional(),
  })
  .passthrough();

const gitLabWatchNoteAuthorSchema = z
  .object({
    username: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const gitLabWatchNoteSchema = z
  .object({
    id: z.number(),
    body: z.string().nullable().optional(),
    system: z.boolean().optional(),
    type: z.string().nullable().optional(),
    position: z.unknown().nullable().optional(),
    author: gitLabWatchNoteAuthorSchema.nullable().optional(),
  })
  .passthrough();

const gitLabWatchDiscussionSchema = z
  .object({
    id: z.string(),
    notes: z.array(gitLabWatchNoteSchema).optional().default([]),
  })
  .passthrough();

const gitLabWatchApprovalsSchema = z
  .object({
    approvals_required: z.number().nullable().optional(),
    approvals_left: z.number().nullable().optional(),
  })
  .passthrough();

type GitLabWatchMr = z.infer<typeof gitLabWatchMrSchema>;
type GitLabWatchJob = z.infer<typeof gitLabWatchJobSchema>;
type GitLabWatchNote = z.infer<typeof gitLabWatchNoteSchema>;
type GitLabWatchDiscussion = z.infer<typeof gitLabWatchDiscussionSchema>;
type GitLabWatchApprovals = z.infer<typeof gitLabWatchApprovalsSchema>;

interface GitLabMergeRequestIdentity {
  protocol: "http:" | "https:";
  host: string;
  port: string;
  hostWithPort: string;
  projectPath: string;
  iid: number;
}

function invalidGitLabUrl(): never {
  throw new Error("Enter a GitLab merge request URL.");
}

function parseGitLabUrlOrigin(input: string): {
  protocol: "http:" | "https:";
  host: string;
  port: string;
  hostWithPort: string;
  pathname: string;
} {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) invalidGitLabUrl();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    invalidGitLabUrl();
  }
  const protocol = parsed.protocol.toLowerCase();
  if ((protocol !== "https:" && protocol !== "http:") || parsed.username || parsed.password) {
    invalidGitLabUrl();
  }
  const host = normalizeHost(parsed.hostname);
  if (!host || (host === GITLAB_CLOUD_HOST && protocol !== "https:")) {
    invalidGitLabUrl();
  }
  return {
    protocol: protocol as "http:" | "https:",
    host,
    port: parsed.port,
    hostWithPort: parsed.port ? `${host}:${parsed.port}` : host,
    pathname: parsed.pathname,
  };
}

function decodeGitLabProjectPath(rawSegments: string[]): string {
  if (rawSegments.length < 2) invalidGitLabUrl();
  const decodedSegments: string[] = [];
  for (const segment of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      invalidGitLabUrl();
    }
    const invalidSegment =
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      decoded === "-" ||
      decoded.includes("/") ||
      decoded.includes("\\");
    if (invalidSegment) invalidGitLabUrl();
    decodedSegments.push(decoded);
  }
  return decodedSegments.join("/");
}

function parseGitLabMergeRequestUrl(input: string): GitLabMergeRequestIdentity {
  const origin = parseGitLabUrlOrigin(input);
  const rawSegments = origin.pathname.split("/").filter((segment) => segment.length > 0);
  if (rawSegments.length < 4) invalidGitLabUrl();

  // Strip an optional browser tab suffix (e.g. /diffs, /commits, /pipelines).
  if (
    rawSegments.length >= 5 &&
    GITLAB_MR_TABS.has(rawSegments[rawSegments.length - 1]!.toLowerCase()) &&
    /^\d+$/.test(rawSegments[rawSegments.length - 2]!)
  ) {
    rawSegments.pop();
  }

  const iidRaw = rawSegments.pop();
  const resource = rawSegments.pop();
  if (!iidRaw || !/^\d+$/.test(iidRaw) || resource?.toLowerCase() !== "merge_requests") {
    invalidGitLabUrl();
  }
  const iid = Number(iidRaw);
  if (!Number.isInteger(iid) || iid < 1 || iid > 2_147_483_647) {
    invalidGitLabUrl();
  }

  // Modern GitLab URLs place `-` before `merge_requests`; legacy URLs omit it.
  if (rawSegments[rawSegments.length - 1] === "-") {
    rawSegments.pop();
  }

  return {
    protocol: origin.protocol,
    host: origin.host,
    port: origin.port,
    hostWithPort: origin.hostWithPort,
    projectPath: decodeGitLabProjectPath(rawSegments),
    iid,
  };
}

export function resolveGitLabChangeRequest(input: string): string {
  const { protocol, hostWithPort, projectPath, iid } = parseGitLabMergeRequestUrl(input);
  return `${protocol}//${hostWithPort}/${projectPath}/-/merge_requests/${iid}`;
}

export function gitlabChangeRequestHost(url: string): string {
  return parseGitLabMergeRequestUrl(url).hostWithPort;
}

export function describeGitLabChangeRequest(url: string): string {
  const { host, port, hostWithPort, projectPath, iid } = parseGitLabMergeRequestUrl(url);
  const project =
    host === GITLAB_CLOUD_HOST && !port ? projectPath : `${hostWithPort}/${projectPath}`;
  return `${project} !${iid}`;
}

function mapGitLabMrState(mr: GitLabWatchMr): ChangeRequestSnapshot["state"] {
  const state = mr.state.toLowerCase();
  // GitLab reports "locked" while a merge is actively in progress; treat it as
  // open so polling continues until GitLab transitions to "merged" (or "closed").
  if (state === "opened" || state === "locked") return "open";
  if (state === "merged" || mr.merged_at != null) return "merged";
  return "closed";
}

function mapGitLabPipelineState(
  status: string | null | undefined,
): ChangeRequestSnapshot["checksState"] {
  if (!status) return "neutral";
  const normalized = status.toLowerCase();
  if (normalized === "success" || normalized === "passed") return "passed";
  if (normalized === "failed") return "failed";
  if (normalized === "manual" || GITLAB_ACTIVE_PIPELINE_STATUS_SET.has(normalized)) {
    return "pending";
  }
  return "neutral";
}

function mapGitLabJobState(job: GitLabWatchJob): ChangeRequestSnapshot["checks"][number]["state"] {
  const raw = job.status.toLowerCase();
  const allowFailure = job.allow_failure ?? false;
  if (raw === "failed") return allowFailure ? "neutral" : "failed";
  if (raw === "success" || raw === "passed") return "passed";
  if (raw === "manual") return allowFailure ? "neutral" : "pending";
  if (GITLAB_ACTIVE_PIPELINE_STATUS_SET.has(raw)) return "pending";
  return "neutral";
}

function toWatchCheck(
  job: GitLabWatchJob,
  prefix: "job" | "bridge",
): ChangeRequestSnapshot["checks"][number] {
  const url = checkUrlSchema.safeParse(job.web_url).data;
  return {
    id: `${prefix}:${job.id}`,
    name: job.name,
    state: mapGitLabJobState(job),
    ...(url ? { url } : {}),
  };
}

type ApprovalNoteAction = "approved" | "unapproved" | "reset";

interface ParsedApprovalNote {
  id: string;
  action: ApprovalNoteAction;
  actor: string | null;
  url: string;
}

function parseGitLabApprovalNote(
  note: GitLabWatchNote,
  mrWebUrl: string,
): ParsedApprovalNote | null {
  if (note.system !== true) return null;
  const body = note.body?.trim().toLowerCase() ?? "";
  if (!body) return null;

  let action: ApprovalNoteAction | null = null;
  if (body === "approved this merge request" || body.startsWith("approved this merge request")) {
    action = "approved";
  } else if (
    body === "unapproved this merge request" ||
    body.startsWith("unapproved this merge request") ||
    body.startsWith("removed approval") ||
    body.startsWith("revoked approval")
  ) {
    action = "unapproved";
  } else if (body.startsWith("reset approvals")) {
    action = "reset";
  }
  if (!action) return null;

  const actor = note.author?.username?.trim() || note.author?.name?.trim() || null;
  return {
    id: `approval-note:${note.id}`,
    action,
    actor,
    url: `${mrWebUrl}#note_${note.id}`,
  };
}

interface ApprovalCount {
  given: number;
  required: number;
}

function summarizeApprovalCount(approvals: GitLabWatchApprovals): ApprovalCount | null {
  const { approvals_required: required, approvals_left: remaining } = approvals;
  if (required == null || remaining == null) return null;
  return { given: Math.max(0, required - remaining), required };
}

function formatApprovalCount(summary: ApprovalCount | null): string {
  if (!summary || summary.required <= 0) return "";
  return ` (${summary.given}/${summary.required} approvals)`;
}

function formatApprovalActor(actor: string | null): string {
  if (!actor) return "";
  return actor.startsWith("@") ? actor : `@${actor}`;
}

function formatApprovalNoteMessage(
  note: ParsedApprovalNote,
  summary: ApprovalCount | null,
): string {
  const actor = formatApprovalActor(note.actor);
  const count = formatApprovalCount(summary);
  if (note.action === "approved") {
    return `Merge request approved${actor ? ` by ${actor}` : ""}${count}: ${note.url}`;
  }
  if (note.action === "unapproved") {
    return `Merge request approval removed${actor ? ` by ${actor}` : ""}${count}: ${note.url}`;
  }
  return `Merge request approvals reset${actor ? ` by ${actor}` : ""}${count}: ${note.url}`;
}

interface ParsedDiscussionItems {
  humanActivity: ChangeRequestSnapshot["activity"];
  approvalNotes: ParsedApprovalNote[];
}

function parseDiscussionItems(
  discussions: GitLabWatchDiscussion[],
  mrWebUrl: string,
): ParsedDiscussionItems {
  const humanActivity: ChangeRequestSnapshot["activity"] = [];
  const approvalNotes: ParsedApprovalNote[] = [];

  for (const discussion of discussions) {
    for (const note of discussion.notes) {
      if (note.system === true) {
        const approvalNote = parseGitLabApprovalNote(note, mrWebUrl);
        if (approvalNote) approvalNotes.push(approvalNote);
        continue;
      }
      const isInline = note.position != null || note.type === "DiffNote";
      humanActivity.push({
        id: isInline ? `inline:${note.id}` : `comment:${note.id}`,
        kind: isInline ? "inline comment" : "comment",
        url: `${mrWebUrl}#note_${note.id}`,
      });
    }
  }

  return { humanActivity, approvalNotes };
}

function resolvePipelineProjectId(
  pipeline: z.infer<typeof gitLabWatchPipelineSchema>,
  mr: GitLabWatchMr,
  encodedProject: string,
): string {
  if (pipeline.project_id != null) return String(pipeline.project_id);
  if (mr.target_project_id != null) return String(mr.target_project_id);
  return encodedProject;
}

function pipelineFailureCheck(
  pipeline: z.infer<typeof gitLabWatchPipelineSchema>,
): ChangeRequestSnapshot["checks"][number] {
  const url = checkUrlSchema.safeParse(pipeline.web_url).data;
  return {
    id: `pipeline:${pipeline.id}`,
    name: `Pipeline #${pipeline.id}`,
    state: "failed",
    ...(url ? { url } : {}),
  };
}

function createRateLimitError(
  host: string,
  nowMs: number,
  headers: ReadonlyMap<string, string>,
): ChangeRequestRateLimitError {
  const resetAtMs = parseRetryAfterMs(headers, nowMs, {
    forceOnMissing: true,
    defaultPauseMs: 60_000,
  })!;
  return new ChangeRequestRateLimitError({ host, resetAtMs });
}

function extractRateLimitFromFailedCommand(
  host: string,
  nowMs: number,
  status: number | null,
  headers: ReadonlyMap<string, string>,
  text: string,
): ChangeRequestRateLimitError | null {
  if (status !== null) {
    return status === 429 ? createRateLimitError(host, nowMs, headers) : null;
  }
  if (!/\b(429|too many requests|rate limit)\b/i.test(text)) return null;
  return createRateLimitError(host, nowMs, headers);
}

export interface CreateGitLabChangeRequestSourceOptions {
  runCommand(
    args: string[],
    options: { cwd: string; envOverlay?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string }>;
  isAuthError(error: unknown): boolean;
  isCommandError(error: unknown): error is Error & { stderr: string; stdout?: string };
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

export function createGitLabChangeRequestSource(
  options: CreateGitLabChangeRequestSourceOptions,
): ChangeRequestSource & { dispose(): void } {
  const now = options.now ?? Date.now;

  async function readConfig(
    host: string,
    key: string,
    envOverlay: Record<string, string> = {},
  ): Promise<string> {
    const config = await options.runCommand(["config", "get", key, "--host", host], {
      cwd: process.cwd(),
      envOverlay: { GITLAB_HOST: host, ...envOverlay },
    });
    return config.stdout.trim();
  }

  async function preferredProfileHost(identity: GitLabMergeRequestIdentity): Promise<string> {
    const { host, hostWithPort } = identity;
    if (hostWithPort === host) return host;

    // An API host override applies to either profile. Use the configured value
    // to decide which profile to try first, then check access through the MR.
    const exactProfile = await readConfig(hostWithPort, "api_host", { GITLAB_API_HOST: "" });
    return exactProfile ? hostWithPort : host;
  }

  async function readApiPrefix(profileHost: string): Promise<string> {
    if (profileHost === GITLAB_CLOUD_HOST) return "";
    const trimSlashes = /^\/+|\/+$/g;
    let prefix = (await readConfig(profileHost, "subfolder")).replace(trimSlashes, "");
    if (!prefix) {
      const apiHost = await readConfig(profileHost, "api_host");
      if (apiHost) {
        const apiUrl = new URL(apiHost.includes("://") ? apiHost : `https://${apiHost}`);
        prefix = apiUrl.pathname.replace(trimSlashes, "");
      }
    }
    return decodeURI(prefix);
  }

  function parseJsonResponseBody<T>(params: {
    args: string[];
    cwd: string;
    body: string;
    schema: z.ZodType<T>;
  }): T {
    let json: unknown;
    try {
      json = JSON.parse(params.body);
    } catch {
      throw options.createCommandError({
        args: params.args,
        cwd: params.cwd,
        exitCode: null,
        stderr: `glab did not return valid JSON (${params.body.length} bytes)`,
      });
    }
    const validated = params.schema.safeParse(json);
    if (!validated.success) {
      throw options.createCommandError({
        args: params.args,
        cwd: params.cwd,
        exitCode: null,
        stderr: `glab JSON did not match the expected schema: ${validated.error.message}`,
      });
    }
    return validated.data;
  }

  function checkHttpStatus(params: {
    host: string;
    args: string[];
    cwd: string;
    status: number | null;
    headers: ReadonlyMap<string, string>;
    body: string;
    rawStdout: string;
    rawStderr: string;
    pauseHost(untilMs: number): void;
  }): void {
    // Only decide rate limits from the HTTP status code on parsed responses so
    // ordinary MR titles, comments, or IIDs mentioning "429" or "rate limit"
    // never trip a false rate-limit pause.
    if (params.status === null) return;
    if (params.status === 429) {
      const error = createRateLimitError(params.host, now(), params.headers);
      params.pauseHost(error.resetAtMs);
      throw error;
    }
    if (params.status === 401) {
      throw options.createAuthError(params.body || params.rawStderr || "401 Unauthorized");
    }
    if (params.status < 200 || params.status >= 300) {
      throw options.createCommandError({
        args: params.args,
        cwd: params.cwd,
        exitCode: null,
        stderr: `HTTP ${params.status}: ${params.body || params.rawStderr}`.trim(),
        stdout: params.rawStdout,
      });
    }
  }

  async function apiGet<T>(params: {
    host: string;
    endpoint: string;
    schema: z.ZodType<T>;
    poll: PerHostReadContext;
  }): Promise<{ data: T; headers: ReadonlyMap<string, string> }> {
    if (!params.poll.isObserved()) throw new Error("Change request observation ended");
    params.poll.assertHostAvailable();
    // glab api rejects a port in --hostname. GITLAB_HOST selects that profile.
    const args = params.host.includes(":")
      ? ["api", "-i", params.endpoint]
      : ["api", "--hostname", params.host, "-i", params.endpoint];
    const cwd = process.cwd();
    let result: { stdout: string; stderr: string };
    try {
      result = await options.runCommand(args, {
        cwd,
        envOverlay: { GITLAB_HOST: params.host },
      });
    } catch (error) {
      if (options.isCommandError(error)) {
        const parsedError = error.stdout ? parseCliHttpResponse(error.stdout) : null;
        const rateLimit = extractRateLimitFromFailedCommand(
          params.host,
          now(),
          parsedError?.status ?? null,
          parsedError?.headers ?? new Map(),
          `${error.stderr}\n${error.stdout ?? ""}`,
        );
        if (rateLimit) {
          params.poll.pauseHost(rateLimit.resetAtMs);
          throw rateLimit;
        }
      }
      throw error;
    }

    const parsed = parseCliHttpResponse(result.stdout);
    checkHttpStatus({
      host: params.host,
      args,
      cwd,
      status: parsed.status,
      headers: parsed.headers,
      body: parsed.body,
      rawStdout: result.stdout,
      rawStderr: result.stderr,
      pauseHost: params.poll.pauseHost,
    });

    const proactivePause = parseRetryAfterMs(parsed.headers, now());
    if (proactivePause !== null) {
      params.poll.deferPollsUntil(proactivePause);
    }

    const data = parseJsonResponseBody({ args, cwd, body: parsed.body, schema: params.schema });
    return { data, headers: parsed.headers };
  }

  async function apiGetAllPages<T>(params: {
    host: string;
    endpoint: string;
    itemSchema: z.ZodType<T>;
    poll: PerHostReadContext;
  }): Promise<{ items: T[]; pagesRead: number }> {
    const items: T[] = [];
    const schema = z.array(params.itemSchema);
    const seenPages = new Set<number>([1]);
    let page = 1;
    let pagesRead = 0;

    while (true) {
      if (!params.poll.isObserved()) {
        return { items, pagesRead };
      }
      const sep = params.endpoint.includes("?") ? "&" : "?";
      const response = await apiGet({
        host: params.host,
        endpoint: `${params.endpoint}${sep}per_page=${GITLAB_PAGE_SIZE}&page=${page}`,
        schema,
        poll: params.poll,
      });
      pagesRead += 1;
      items.push(...response.data);

      const nextPageHeader = response.headers.get("x-next-page");
      if (nextPageHeader !== undefined) {
        const trimmed = nextPageHeader.trim();
        if (!trimmed) break;
        const nextPage = Number(trimmed);
        if (!Number.isInteger(nextPage) || nextPage <= 0 || seenPages.has(nextPage)) {
          throw new Error("GitLab returned an invalid pagination header.");
        }
        seenPages.add(nextPage);
        page = nextPage;
      } else {
        if (response.data.length < GITLAB_PAGE_SIZE) break;
        page += 1;
        seenPages.add(page);
      }
    }

    return { items, pagesRead };
  }

  function commandErrorStatus(error: unknown): number | null {
    return options.isCommandError(error) && error.stdout
      ? parseCliHttpResponse(error.stdout).status
      : null;
  }

  async function readMergeRequestMetadata(params: {
    host: string;
    identity: GitLabMergeRequestIdentity;
    endpoint: string;
    poll: PerHostReadContext;
  }): Promise<GitLabWatchMr> {
    const { data: mr } = await apiGet({
      host: params.host,
      endpoint: params.endpoint,
      schema: gitLabWatchMrSchema,
      poll: params.poll,
    });
    const address = parseGitLabMergeRequestUrl(mr.web_url);
    const expected = params.identity;
    if (address.protocol !== expected.protocol || address.hostWithPort !== expected.hostWithPort) {
      throw new Error(
        `GitLab returned a merge request from a different web origin: ${address.protocol}//${address.hostWithPort}`,
      );
    }
    if (address.projectPath.toLowerCase() !== expected.projectPath.toLowerCase()) {
      throw new Error("GitLab returned a merge request from a different project.");
    }
    if (address.iid !== expected.iid || mr.iid !== expected.iid) {
      throw new Error("GitLab returned a different merge request number.");
    }
    return mr;
  }

  function pipelineDetailsUnavailable(error: unknown): boolean {
    const status = commandErrorStatus(error);
    return status === 403 || status === 404;
  }

  async function readPipelineChecks(params: {
    host: string;
    identity: GitLabMergeRequestIdentity;
    mrEndpoint: string;
    encodedProject: string;
    mr: GitLabWatchMr;
    headSha: string;
    poll: PerHostReadContext;
  }): Promise<ChangeRequestSnapshot["checks"]> {
    const pipeline = params.mr.head_pipeline;
    if (!pipeline) return [];

    const pipelineProject = resolvePipelineProjectId(pipeline, params.mr, params.encodedProject);
    let jobsResult: { items: GitLabWatchJob[]; pagesRead: number };
    try {
      jobsResult = await apiGetAllPages({
        host: params.host,
        endpoint: `projects/${pipelineProject}/pipelines/${pipeline.id}/jobs`,
        itemSchema: gitLabWatchJobSchema,
        poll: params.poll,
      });
    } catch (error) {
      if (!pipelineDetailsUnavailable(error)) throw error;
      // The MR can expose pipeline status even when its jobs are restricted.
      return mapGitLabPipelineState(pipeline.status) === "failed"
        ? [pipelineFailureCheck(pipeline)]
        : [];
    }
    if (!params.poll.isObserved()) {
      throw new Error("Change request observation ended");
    }

    const checks = jobsResult.items.map((job) => toWatchCheck(job, "job"));
    let fetchedBridges = false;
    if (
      mapGitLabPipelineState(pipeline.status) === "failed" &&
      !checks.some((check) => check.state === "failed")
    ) {
      fetchedBridges = true;
      await appendFailedBridgeOrPipelineChecks({
        host: params.host,
        pipelineProject,
        pipeline,
        checks,
        poll: params.poll,
      });
    }

    // Guard against headSha or head_pipeline shifting while paginating check pages.
    if (jobsResult.pagesRead > 1 || fetchedBridges) {
      const recheck = await readMergeRequestMetadata({
        host: params.host,
        identity: params.identity,
        endpoint: params.mrEndpoint,
        poll: params.poll,
      });
      const recheckSha = recheck.sha || recheck.diff_refs?.head_sha || "";
      if (
        recheckSha !== params.headSha ||
        recheck.head_pipeline?.id !== pipeline.id ||
        recheck.head_pipeline?.status !== pipeline.status
      ) {
        throw new Error("The merge request head or pipeline changed during pagination.");
      }
    }
    return checks;
  }

  async function appendFailedBridgeOrPipelineChecks(params: {
    host: string;
    pipelineProject: string;
    pipeline: z.infer<typeof gitLabWatchPipelineSchema>;
    checks: ChangeRequestSnapshot["checks"];
    poll: PerHostReadContext;
  }): Promise<void> {
    try {
      const bridgesResult = await apiGetAllPages({
        host: params.host,
        endpoint: `projects/${params.pipelineProject}/pipelines/${params.pipeline.id}/bridges`,
        itemSchema: gitLabWatchJobSchema,
        poll: params.poll,
      });
      for (const bridge of bridgesResult.items) {
        params.checks.push(toWatchCheck(bridge, "bridge"));
      }
    } catch (error) {
      if (!pipelineDetailsUnavailable(error)) throw error;
    }
    if (!params.checks.some((check) => check.state === "failed")) {
      params.checks.push(pipelineFailureCheck(params.pipeline));
    }
  }

  async function readOptionalApprovalCount(params: {
    host: string;
    endpoint: string;
    poll: PerHostReadContext;
  }): Promise<ApprovalCount | null> {
    try {
      const { data: approvals } = await apiGet({
        host: params.host,
        endpoint: params.endpoint,
        schema: gitLabWatchApprovalsSchema,
        poll: params.poll,
      });
      return summarizeApprovalCount(approvals);
    } catch {
      // The approval system note is complete without an API count.
      return null;
    }
  }

  async function readInitialMergeRequest(
    identity: GitLabMergeRequestIdentity,
    poll: PerHostReadContext,
  ) {
    async function readUsing(host: string) {
      const { projectPath, iid } = identity;
      const prefix = await readApiPrefix(host);
      const relativePath =
        prefix && projectPath.startsWith(`${prefix}/`)
          ? projectPath.slice(prefix.length + 1)
          : projectPath;
      const encodedProject = encodeURIComponent(
        relativePath.includes("/") ? relativePath : projectPath,
      );
      const mrEndpoint = `projects/${encodedProject}/merge_requests/${iid}`;
      const mr = await readMergeRequestMetadata({ host, identity, endpoint: mrEndpoint, poll });
      return { host, encodedProject, mrEndpoint, mr };
    }

    const preferred = await preferredProfileHost(identity);
    try {
      return await readUsing(preferred);
    } catch (error) {
      const status = commandErrorStatus(error);
      const accessDenied = options.isAuthError(error) || status === 403 || status === 404;
      if (preferred === identity.host || !accessDenied) throw error;
      return readUsing(identity.host);
    }
  }

  async function readMergeRequest(context: PerHostReadContext): Promise<ChangeRequestSnapshot> {
    const identity = parseGitLabMergeRequestUrl(context.url);
    const { iid } = identity;
    const { host, encodedProject, mrEndpoint, mr } = await readInitialMergeRequest(
      identity,
      context,
    );
    const headSha = mr.sha || mr.diff_refs?.head_sha || "";
    if (!headSha) {
      throw new Error(`GitLab merge request !${iid} did not include a head commit SHA.`);
    }

    const checks = await readPipelineChecks({
      host,
      identity,
      mrEndpoint,
      encodedProject,
      mr,
      headSha,
      poll: context,
    });
    const discussionsResult = await apiGetAllPages({
      host,
      endpoint: `projects/${encodedProject}/merge_requests/${iid}/discussions`,
      itemSchema: gitLabWatchDiscussionSchema,
      poll: context,
    });
    if (!context.isObserved()) {
      throw new Error("Change request observation ended");
    }

    const { humanActivity, approvalNotes } = parseDiscussionItems(
      discussionsResult.items,
      mr.web_url,
    );
    const known = context.knownActivity();
    const hasNewApprovalNote =
      known !== undefined && approvalNotes.some((note) => !known.has(note.id));
    // Fetch /approvals only to enrich a newly observed approval system note with
    // current counts — keeping seenActivity as the single persisted owner of
    // approval transition baselines.
    const approvalCount = hasNewApprovalNote
      ? await readOptionalApprovalCount({
          host,
          endpoint: `projects/${encodedProject}/merge_requests/${iid}/approvals`,
          poll: context,
        })
      : null;

    const activity: ChangeRequestSnapshot["activity"] = [
      ...humanActivity,
      ...approvalNotes.map((note) => ({
        id: note.id,
        kind: "approval" as const,
        url: note.url,
        message: formatApprovalNoteMessage(note, approvalCount),
      })),
    ];

    return {
      state: mapGitLabMrState(mr),
      headSha,
      checksState: mapGitLabPipelineState(mr.head_pipeline?.status),
      checks,
      reviewDecision: null,
      activity,
    };
  }

  const poller = createPerHostChangeRequestPoller({
    hostOf: gitlabChangeRequestHost,
    read: readMergeRequest,
    now,
    pollIntervalMs: options.pollIntervalMs,
    initialDelayMs: options.initialDelayMs,
  });

  return {
    resolve: resolveGitLabChangeRequest,
    describe: describeGitLabChangeRequest,
    observe(url, callbacks) {
      return poller.observe(url, callbacks);
    },
    dispose() {
      poller.dispose();
    },
  };
}
