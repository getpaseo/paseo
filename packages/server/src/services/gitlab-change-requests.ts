import { z } from "zod";
import { normalizeHost } from "@getpaseo/protocol/git-remote";
import { GITLAB_ACTIVE_PIPELINE_STATUS_SET } from "@getpaseo/protocol/gitlab-pipeline";
import {
  ChangeRequestRateLimitError,
  createPerHostChangeRequestPoller,
  parseCliHttpResponse,
  parseRetryAfterMs,
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
    web_url: z.string().optional(),
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

const gitLabWatchApproverSchema = z
  .object({
    user: z
      .object({
        id: z.number().optional(),
        username: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    approved_at: z.string().nullable().optional(),
  })
  .passthrough();

const gitLabWatchApprovalsSchema = z
  .object({
    approved: z.boolean().optional(),
    approvals_required: z.number().nullable().optional(),
    approvals_left: z.number().nullable().optional(),
    approved_by: z.array(gitLabWatchApproverSchema).nullable().optional(),
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
  if (state === "opened") return "open";
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

interface ApprovalSummary {
  approvers: Map<string, string | null>;
  given: number;
  required: number;
  satisfied: boolean;
}

function computeApprovalsGiven(approvals: GitLabWatchApprovals): number {
  if (approvals.approved_by != null) {
    return approvals.approved_by.length;
  }
  if (approvals.approvals_required != null && approvals.approvals_left != null) {
    return Math.max(0, approvals.approvals_required - approvals.approvals_left);
  }
  return 0;
}

function computeApprovalsSatisfied(
  approvals: GitLabWatchApprovals,
  given: number,
  required: number,
): boolean {
  if (approvals.approved !== undefined) return approvals.approved;
  if (required <= 0) return given > 0;
  if (approvals.approvals_left != null) return approvals.approvals_left <= 0;
  return given >= required;
}

function summarizeGitLabApprovals(approvals: GitLabWatchApprovals): ApprovalSummary {
  const approvers = new Map<string, string | null>();
  for (const entry of approvals.approved_by ?? []) {
    const key =
      entry.user?.username?.trim() ||
      entry.user?.name?.trim() ||
      (entry.user?.id != null ? String(entry.user.id) : "");
    if (!key) continue;
    approvers.set(key, entry.approved_at ?? null);
  }
  const required = approvals.approvals_required ?? 0;
  const given = computeApprovalsGiven(approvals);
  const satisfied = computeApprovalsSatisfied(approvals, given, required);
  return { approvers, given, required, satisfied };
}

function formatApprovalCount(summary: ApprovalSummary | null): string {
  if (!summary || summary.required <= 0) return "";
  return ` (${summary.given}/${summary.required} approvals)`;
}

function formatApprovalActor(actor: string | null): string {
  if (!actor) return "";
  return actor.startsWith("@") ? actor : `@${actor}`;
}

function formatApprovalNoteMessage(
  note: ParsedApprovalNote,
  summary: ApprovalSummary | null,
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

interface DiscussionActivityResult {
  activity: ChangeRequestSnapshot["activity"];
  newApprovedActors: Set<string>;
  newUnapprovedActors: Set<string>;
  hadNewResetNote: boolean;
}

function collectDiscussionActivity(
  discussions: GitLabWatchDiscussion[],
  mrWebUrl: string,
  known: ReadonlySet<string> | undefined,
  approvalSummary: ApprovalSummary | null,
): DiscussionActivityResult {
  const activity: ChangeRequestSnapshot["activity"] = [];
  const newApprovedActors = new Set<string>();
  const newUnapprovedActors = new Set<string>();
  let hadNewResetNote = false;

  for (const discussion of discussions) {
    for (const note of discussion.notes) {
      if (note.system === true) {
        const approvalNote = parseGitLabApprovalNote(note, mrWebUrl);
        if (!approvalNote) continue;
        if (!known?.has(approvalNote.id)) {
          recordNewApprovalNoteActor(approvalNote, newApprovedActors, newUnapprovedActors, () => {
            hadNewResetNote = true;
          });
        }
        activity.push({
          id: approvalNote.id,
          kind: "approval",
          url: approvalNote.url,
          message: formatApprovalNoteMessage(approvalNote, approvalSummary),
        });
        continue;
      }
      const isInline = note.position != null || note.type === "DiffNote";
      activity.push({
        id: isInline ? `inline:${note.id}` : `comment:${note.id}`,
        kind: isInline ? "inline comment" : "comment",
        url: `${mrWebUrl}#note_${note.id}`,
      });
    }
  }

  return { activity, newApprovedActors, newUnapprovedActors, hadNewResetNote };
}

function recordNewApprovalNoteActor(
  note: ParsedApprovalNote,
  approved: Set<string>,
  unapproved: Set<string>,
  markReset: () => void,
): void {
  if (note.action === "approved" && note.actor) {
    approved.add(note.actor.toLowerCase());
  } else if (note.action === "unapproved" && note.actor) {
    unapproved.add(note.actor.toLowerCase());
  } else if (note.action === "reset") {
    markReset();
  }
}

function collectSummaryApprovalTransitions(params: {
  previous: ApprovalSummary;
  current: ApprovalSummary;
  mrWebUrl: string;
  notes: DiscussionActivityResult;
  nextSeq: () => number;
}): ChangeRequestSnapshot["activity"] {
  const { previous, current, mrWebUrl, notes, nextSeq } = params;
  const count = formatApprovalCount(current);
  const emitted: ChangeRequestSnapshot["activity"] = [];

  for (const [actor, approvedAt] of current.approvers) {
    if (previous.approvers.has(actor)) continue;
    if (notes.newApprovedActors.has(actor.toLowerCase())) continue;
    emitted.push({
      id: `approval:added:${actor}:${approvedAt ?? nextSeq()}`,
      kind: "approval",
      url: mrWebUrl,
      message: `Merge request approved by ${formatApprovalActor(actor)}${count}: ${mrWebUrl}`,
    });
  }
  for (const actor of previous.approvers.keys()) {
    if (current.approvers.has(actor)) continue;
    if (notes.hadNewResetNote || notes.newUnapprovedActors.has(actor.toLowerCase())) continue;
    emitted.push({
      id: `approval:removed:${actor}:${nextSeq()}`,
      kind: "approval",
      url: mrWebUrl,
      message: `Merge request approval removed by ${formatApprovalActor(actor)}${count}: ${mrWebUrl}`,
    });
  }
  const hasActorEvent =
    emitted.length > 0 ||
    notes.newApprovedActors.size > 0 ||
    notes.newUnapprovedActors.size > 0 ||
    notes.hadNewResetNote;
  if (!hasActorEvent && current.required > 0 && previous.satisfied !== current.satisfied) {
    emitted.push({
      id: `approval:status:${current.satisfied ? "satisfied" : "pending"}:${current.given}/${current.required}:${nextSeq()}`,
      kind: "approval",
      url: mrWebUrl,
      message: current.satisfied
        ? `Merge request approvals satisfied${count}: ${mrWebUrl}`
        : `Merge request needs approvals${count}: ${mrWebUrl}`,
    });
  }
  return emitted;
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

function isApprovalsEndpointUnavailable(status: number | null, text: string): boolean {
  if (status === 403 || status === 404 || status === 501) return true;
  return /\b(403|404|501|not found|forbidden)\b/i.test(text);
}

function isNotFoundError(status: number | null, text: string): boolean {
  if (status === 404) return true;
  return /\b(404|not found)\b/i.test(text);
}

function extractRateLimitError(
  host: string,
  nowMs: number,
  status: number | null,
  headers: ReadonlyMap<string, string>,
  text: string,
): ChangeRequestRateLimitError | null {
  const isRateLimited = status === 429 || /\b(429|too many requests|rate limit)\b/i.test(text);
  if (!isRateLimited) return null;
  const resetAtMs = parseRetryAfterMs(headers, nowMs, {
    forceOnMissing: true,
    defaultPauseMs: 60_000,
  })!;
  return new ChangeRequestRateLimitError({ host, resetAtMs });
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
  const authenticatedWatchHosts = new Set<string>();
  const lastApprovalsByUrl = new Map<string, ApprovalSummary>();
  let approvalEventSeq = 0;

  async function ensureHostAuthenticated(host: string): Promise<void> {
    if (host === GITLAB_CLOUD_HOST || authenticatedWatchHosts.has(host)) {
      return;
    }
    await options.runCommand(["auth", "status", "--hostname", host], {
      cwd: process.cwd(),
      envOverlay: { GITLAB_HOST: host },
    });
    authenticatedWatchHosts.add(host);
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
  }): void {
    const rateLimit = extractRateLimitError(
      params.host,
      now(),
      params.status,
      params.headers,
      `${params.rawStderr}\n${params.body}`,
    );
    if (rateLimit) throw rateLimit;
    if (params.status === null) return;
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
    pauseHost(untilMs: number): void;
  }): Promise<{ data: T; headers: ReadonlyMap<string, string> }> {
    const args = ["api", "--hostname", params.host, "-i", params.endpoint];
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
        const rateLimit = extractRateLimitError(
          params.host,
          now(),
          parsedError?.status ?? null,
          parsedError?.headers ?? new Map(),
          `${error.stderr}\n${error.stdout ?? ""}`,
        );
        if (rateLimit) throw rateLimit;
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
    });

    const proactivePause = parseRetryAfterMs(parsed.headers, now());
    if (proactivePause !== null) {
      params.pauseHost(proactivePause);
    }

    const data = parseJsonResponseBody({ args, cwd, body: parsed.body, schema: params.schema });
    return { data, headers: parsed.headers };
  }

  async function apiGetAllPages<T>(params: {
    host: string;
    endpoint: string;
    itemSchema: z.ZodType<T>;
    isObserved(): boolean;
    pauseHost(untilMs: number): void;
  }): Promise<{ items: T[]; pagesRead: number }> {
    const items: T[] = [];
    const schema = z.array(params.itemSchema);
    const seenPages = new Set<number>([1]);
    let page = 1;
    let pagesRead = 0;

    while (true) {
      if (!params.isObserved()) {
        return { items, pagesRead };
      }
      const sep = params.endpoint.includes("?") ? "&" : "?";
      const response = await apiGet({
        host: params.host,
        endpoint: `${params.endpoint}${sep}per_page=${GITLAB_PAGE_SIZE}&page=${page}`,
        schema,
        pauseHost: params.pauseHost,
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

  function extractCommandErrorStatus(error: unknown): { status: number | null; stderr: string } {
    if (!options.isCommandError(error)) return { status: null, stderr: "" };
    const status = error.stdout ? parseCliHttpResponse(error.stdout).status : null;
    return { status, stderr: error.stderr };
  }

  async function readPipelineChecks(params: {
    host: string;
    mrEndpoint: string;
    encodedProject: string;
    mr: GitLabWatchMr;
    headSha: string;
    isObserved(): boolean;
    pauseHost(untilMs: number): void;
  }): Promise<ChangeRequestSnapshot["checks"]> {
    const pipeline = params.mr.head_pipeline;
    if (!pipeline) return [];

    const pipelineProject = resolvePipelineProjectId(pipeline, params.mr, params.encodedProject);
    const jobsResult = await apiGetAllPages({
      host: params.host,
      endpoint: `projects/${pipelineProject}/pipelines/${pipeline.id}/jobs`,
      itemSchema: gitLabWatchJobSchema,
      isObserved: params.isObserved,
      pauseHost: params.pauseHost,
    });
    if (!params.isObserved()) {
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
        isObserved: params.isObserved,
        pauseHost: params.pauseHost,
      });
    }

    // Guard against headSha or head_pipeline shifting while paginating check pages.
    if (jobsResult.pagesRead > 1 || fetchedBridges) {
      const { data: recheck } = await apiGet({
        host: params.host,
        endpoint: params.mrEndpoint,
        schema: gitLabWatchMrSchema,
        pauseHost: params.pauseHost,
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
    isObserved(): boolean;
    pauseHost(untilMs: number): void;
  }): Promise<void> {
    try {
      const bridgesResult = await apiGetAllPages({
        host: params.host,
        endpoint: `projects/${params.pipelineProject}/pipelines/${params.pipeline.id}/bridges`,
        itemSchema: gitLabWatchJobSchema,
        isObserved: params.isObserved,
        pauseHost: params.pauseHost,
      });
      for (const bridge of bridgesResult.items) {
        params.checks.push(toWatchCheck(bridge, "bridge"));
      }
    } catch (error) {
      const { status, stderr } = extractCommandErrorStatus(error);
      if (!isNotFoundError(status, stderr)) {
        throw error;
      }
    }
    if (!params.checks.some((check) => check.state === "failed")) {
      const pipelineUrl = checkUrlSchema.safeParse(params.pipeline.web_url).data;
      params.checks.push({
        id: `pipeline:${params.pipeline.id}`,
        name: `Pipeline #${params.pipeline.id}`,
        state: "failed",
        ...(pipelineUrl ? { url: pipelineUrl } : {}),
      });
    }
  }

  async function readOptionalApprovals(params: {
    host: string;
    endpoint: string;
    pauseHost(untilMs: number): void;
  }): Promise<ApprovalSummary | null> {
    try {
      const { data: approvals } = await apiGet({
        host: params.host,
        endpoint: params.endpoint,
        schema: gitLabWatchApprovalsSchema,
        pauseHost: params.pauseHost,
      });
      return summarizeGitLabApprovals(approvals);
    } catch (error) {
      if (options.isAuthError(error) || error instanceof ChangeRequestRateLimitError) {
        throw error;
      }
      const { status, stderr } = extractCommandErrorStatus(error);
      if (isApprovalsEndpointUnavailable(status, stderr)) {
        return null;
      }
      throw error;
    }
  }

  async function readMergeRequest(context: {
    url: string;
    host: string;
    knownActivity(): ReadonlySet<string> | undefined;
    isObserved(): boolean;
    pauseHost(untilMs: number): void;
  }): Promise<ChangeRequestSnapshot> {
    const { hostWithPort, projectPath, iid } = parseGitLabMergeRequestUrl(context.url);
    await ensureHostAuthenticated(hostWithPort);
    const encodedProject = encodeURIComponent(projectPath);
    const mrEndpoint = `projects/${encodedProject}/merge_requests/${iid}`;

    const { data: mr } = await apiGet({
      host: hostWithPort,
      endpoint: mrEndpoint,
      schema: gitLabWatchMrSchema,
      pauseHost: context.pauseHost,
    });
    const headSha = mr.sha || mr.diff_refs?.head_sha || "";
    if (!headSha) {
      throw new Error(`GitLab merge request !${iid} did not include a head commit SHA.`);
    }
    const mrWebUrl = mr.web_url || context.url;

    const checks = await readPipelineChecks({
      host: hostWithPort,
      mrEndpoint,
      encodedProject,
      mr,
      headSha,
      isObserved: context.isObserved,
      pauseHost: context.pauseHost,
    });
    const discussionsResult = await apiGetAllPages({
      host: hostWithPort,
      endpoint: `projects/${encodedProject}/merge_requests/${iid}/discussions`,
      itemSchema: gitLabWatchDiscussionSchema,
      isObserved: context.isObserved,
      pauseHost: context.pauseHost,
    });
    if (!context.isObserved()) {
      throw new Error("Change request observation ended");
    }

    const approvalSummary = await readOptionalApprovals({
      host: hostWithPort,
      endpoint: `projects/${encodedProject}/merge_requests/${iid}/approvals`,
      pauseHost: context.pauseHost,
    });

    const notesResult = collectDiscussionActivity(
      discussionsResult.items,
      mrWebUrl,
      context.knownActivity(),
      approvalSummary,
    );
    const activity = [...notesResult.activity];

    if (approvalSummary) {
      const previous = lastApprovalsByUrl.get(context.url);
      if (previous) {
        activity.push(
          ...collectSummaryApprovalTransitions({
            previous,
            current: approvalSummary,
            mrWebUrl,
            notes: notesResult,
            nextSeq: () => {
              approvalEventSeq += 1;
              return approvalEventSeq;
            },
          }),
        );
      }
      lastApprovalsByUrl.set(context.url, approvalSummary);
    }

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
    onError(error, host) {
      if (options.isAuthError(error)) {
        authenticatedWatchHosts.delete(host);
      }
    },
  });

  return {
    resolve: resolveGitLabChangeRequest,
    describe: describeGitLabChangeRequest,
    observe(url, callbacks) {
      const release = poller.observe(url, callbacks);
      return () => {
        lastApprovalsByUrl.delete(url);
        release();
      };
    },
    dispose() {
      lastApprovalsByUrl.clear();
      authenticatedWatchHosts.clear();
      poller.dispose();
    },
  };
}
