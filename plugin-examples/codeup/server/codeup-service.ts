import { z } from "zod";
import { parseGitRemoteLocation, type GitRemoteLocation } from "../shared/git-remote";
import { findExecutable } from "./process";
import {
  createCachedCliPathResolver,
  createForgeCliRunner,
  defaultResolveRemoteUrl,
  ForgeAuthenticationError,
  ForgeCliMissingError,
  ForgeCommandError,
  parseCliJsonOutput,
  type ForgeCommandFailureParams,
} from "./forge-cli";
import {
  compareTimelineItems,
  computeChecksStatus,
  createUnavailableSearchResult,
  normalizeForgeSearchKinds,
  parseOptionalTime,
} from "@getpaseo/plugin/server";
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
  PullRequestAutoMergeResult,
  PullRequestCheck,
  PullRequestCheckoutTarget,
  PullRequestCreateResult,
  PullRequestMergeable,
  PullRequestMergeResult,
  PullRequestSummary,
  PullRequestTimeline,
  PullRequestTimelineCommentLocation,
  PullRequestTimelineError,
  PullRequestTimelineItem,
  SearchIssuesAndPrsOptions,
  SearchResult,
} from "@getpaseo/plugin/server";
import {
  isCodeupDirectMergeReady,
  parseCodeupStatusFacts,
  type CodeupRequirementChecks,
  type CodeupStatusFacts,
} from "../shared/codeup-facts";

const ALIYUN_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} as const;

const ALIYUN_COMMAND_TIMEOUT_MS = 30_000;
const CODEUP_HOST = "codeup.aliyun.com";
const CODEUP_REGION = "cn-hangzhou";
const CODEUP_ENDPOINT = "devops.cn-hangzhou.aliyuncs.com";
const CODEUP_PAGE_SIZE = 100;
const CODEUP_MAX_CONTINUATIONS_WITHOUT_TOTAL = 100;
const REDACTED_ALIYUN_ARGUMENT = "<redacted>";
const SENSITIVE_ALIYUN_FLAGS = new Set(["--body", "--search"]);

function assertCodeupPageProgress(input: {
  itemCount: number;
  pageSize: number;
  pageKeys: readonly string[];
  seenFullPageFingerprints: Set<string>;
}): void {
  if (input.itemCount < input.pageSize) return;
  const fingerprint = JSON.stringify(input.pageKeys);
  if (input.seenFullPageFingerprints.has(fingerprint)) {
    throw new Error("Codeup pagination repeated a full page without making progress");
  }
  input.seenFullPageFingerprints.add(fingerprint);
}

function hasNextCodeupPage(input: {
  itemCount: number;
  pageSize: number;
  page: number;
  visited: number;
  total: number | undefined;
}): boolean {
  if (input.itemCount < input.pageSize) return false;
  if (input.total !== undefined) return input.visited < input.total;
  if (input.page > CODEUP_MAX_CONTINUATIONS_WITHOUT_TOTAL) {
    throw new Error(
      `Codeup pagination exceeded ${CODEUP_MAX_CONTINUATIONS_WITHOUT_TOTAL} continuations without total`,
    );
  }
  return true;
}

export class AliyunCliMissingError extends ForgeCliMissingError {
  constructor() {
    super("Alibaba Cloud CLI (aliyun) is not installed or not in PATH");
    this.name = "AliyunCliMissingError";
  }
}

export class AliyunAuthenticationError extends ForgeAuthenticationError {
  constructor(params: { stderr: string }) {
    super("Alibaba Cloud CLI authentication failed", params);
    this.name = "AliyunAuthenticationError";
  }
}

export class AliyunCommandError extends ForgeCommandError {
  constructor(params: ForgeCommandFailureParams) {
    super(
      { brand: "Codeup", binary: "aliyun" },
      { ...params, args: redactAliyunArgs(params.args) },
    );
    this.name = "AliyunCommandError";
  }
}

export function redactAliyunArgs(args: readonly string[]): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const equalsIndex = argument.indexOf("=");
    const flag = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
    if (!SENSITIVE_ALIYUN_FLAGS.has(flag)) {
      redacted.push(argument);
      continue;
    }
    redacted.push(equalsIndex >= 0 ? `${flag}=${REDACTED_ALIYUN_ARGUMENT}` : flag);
    if (equalsIndex < 0 && index + 1 < args.length) {
      redacted.push(REDACTED_ALIYUN_ARGUMENT);
      index += 1;
    }
  }
  return redacted;
}

export interface CodeupCommandRunnerOptions {
  cwd: string;
  binaryPath?: string;
  envOverlay?: Record<string, string>;
}

export interface CodeupCommandResult {
  stdout: string;
  stderr: string;
}

export type CodeupCommandRunner = (
  args: string[],
  options: CodeupCommandRunnerOptions,
) => Promise<CodeupCommandResult>;

export interface CreateCodeupServiceOptions {
  runner?: CodeupCommandRunner;
  resolveAliyunPath?: () => Promise<string | null>;
  resolveRemoteUrl?: (cwd: string) => Promise<string | null>;
}

export interface CodeupRemoteIdentity {
  organizationId: string;
  repositoryIdentity: string;
}

const CodeupApiEnvelopeSchema = z
  .object({
    success: z.boolean().optional(),
    errorCode: z.union([z.string(), z.number()]).nullable().optional(),
    errorMessage: z.string().nullable().optional(),
  })
  .passthrough();

const CodeupRepositorySchema = z
  .object({
    id: z.number(),
    name: z.string().optional(),
    path: z.string().optional(),
    pathWithNamespace: z.string(),
    defaultBranch: z.string().optional(),
    sshUrlToRepository: z.string().nullable().optional(),
    httpUrlToRepository: z.string().nullable().optional(),
    webUrl: z.string().nullable().optional(),
  })
  .passthrough();

const CodeupGetRepositoryResponseSchema = CodeupApiEnvelopeSchema.extend({
  repository: CodeupRepositorySchema.optional(),
});

const CodeupUserSchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
    username: z.string().optional(),
    avatarUrl: z.string().nullable().optional(),
    hasReviewed: z.boolean().optional(),
    reviewOpinionStatus: z.string().nullable().optional(),
    reviewTime: z.string().nullable().optional(),
  })
  .passthrough();

const CodeupLabelSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
  })
  .passthrough();

const CodeupMergeRequestListItemSchema = z
  .object({
    id: z.number().optional(),
    iid: z.number().optional(),
    localId: z.number(),
    projectId: z.number(),
    sourceProjectId: z.number(),
    targetProjectId: z.number(),
    sourceBranch: z.string(),
    targetBranch: z.string(),
    title: z.string(),
    description: z.string().nullable().optional(),
    state: z.string(),
    workInProgress: z.boolean().optional(),
    labels: z.array(CodeupLabelSchema).optional(),
    updatedAt: z.string().optional(),
    detailUrl: z.string().nullable().optional(),
    webUrl: z.string().nullable().optional(),
    nameWithNamespace: z.string().optional(),
  })
  .passthrough();

const CodeupListMergeRequestsResponseSchema = CodeupApiEnvelopeSchema.extend({
  result: z.array(CodeupMergeRequestListItemSchema).optional(),
  total: z.number().optional(),
});

const CodeupRequirementCheckSchema = z
  .object({
    itemType: z.string(),
    pass: z.boolean(),
  })
  .passthrough();

const CodeupMergeRequestDetailSchema = z
  .object({
    localId: z.number(),
    projectId: z.number(),
    sourceProjectId: z.number(),
    targetProjectId: z.number(),
    sourceBranch: z.string(),
    targetBranch: z.string(),
    title: z.string(),
    description: z.string().nullable().optional(),
    status: z.string(),
    createTime: z.string().optional(),
    updateTime: z.string().optional(),
    reviewers: z.array(CodeupUserSchema).optional(),
    allRequirementsPass: z.boolean().optional(),
    todoList: z
      .object({
        requirementCheckItems: z.array(CodeupRequirementCheckSchema).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    detailUrl: z.string().nullable().optional(),
    webUrl: z.string().nullable().optional(),
    targetProjectPathWithNamespace: z.string().optional(),
    mergedRevision: z.string().nullable().optional(),
  })
  .passthrough();

const CodeupGetMergeRequestResponseSchema = CodeupApiEnvelopeSchema.extend({
  result: CodeupMergeRequestDetailSchema.optional(),
});

const CodeupPatchSetSchema = z
  .object({
    commitId: z.string().optional(),
    patchSetNo: z.number().optional(),
    relatedMergeItemType: z.string().optional(),
  })
  .passthrough();

const CodeupListPatchSetsResponseSchema = CodeupApiEnvelopeSchema.extend({
  result: z.array(CodeupPatchSetSchema).optional(),
});

const CodeupCheckOutputSchema = z
  .object({
    title: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
  })
  .passthrough();

const CodeupCheckAnnotationSchema = z
  .object({
    path: z.string().optional(),
    startLine: z.number().optional(),
    endLine: z.number().optional(),
    annotationLevel: z.string().optional(),
    message: z.string().optional(),
    title: z.string().optional(),
    rawDetails: z.string().optional(),
  })
  .passthrough();

const CodeupCheckRunSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable().optional(),
    detailsUrl: z.string().nullable().optional(),
    startedAt: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
    output: CodeupCheckOutputSchema.nullable().optional(),
    annotations: z.array(CodeupCheckAnnotationSchema).optional(),
  })
  .passthrough();

const CodeupListCheckRunsResponseSchema = CodeupApiEnvelopeSchema.extend({
  result: z.array(CodeupCheckRunSchema).optional(),
  total: z.number().optional(),
});

const CodeupGetCheckRunResponseSchema = CodeupApiEnvelopeSchema.extend({
  result: CodeupCheckRunSchema.optional(),
});

const CodeupCommitStatusSchema = z
  .object({
    id: z.number().optional(),
    context: z.string().optional(),
    description: z.string().nullable().optional(),
    state: z.string(),
    targetUrl: z.string().nullable().optional(),
  })
  .passthrough();

const CodeupListCommitStatusesResponseSchema = CodeupApiEnvelopeSchema.extend({
  result: z.array(CodeupCommitStatusSchema).optional(),
  total: z.number().optional(),
});

const CodeupCommentSchema = z
  .object({
    commentBizId: z.string(),
    parentCommentBizId: z.string().nullable().optional(),
    rootCommentBizId: z.string().nullable().optional(),
    commentTime: z.string().nullable().optional(),
    commentType: z.string().optional(),
    content: z.string().nullable().optional(),
    deleted: z.boolean().optional(),
    filePath: z.string().nullable().optional(),
    lineNumber: z.string().nullable().optional(),
    resolved: z.boolean().optional(),
    author: CodeupUserSchema.nullable().optional(),
    childComments: z.array(z.unknown()).optional(),
    finalChildComments: z.array(z.unknown()).optional(),
  })
  .passthrough();

const CodeupListCommentsResponseSchema = CodeupApiEnvelopeSchema.extend({
  result: z.array(z.unknown()).optional(),
});

const CodeupCreateMergeRequestResponseSchema = CodeupApiEnvelopeSchema.extend({
  // The create response is intentionally smaller than GetMergeRequest (for
  // example, Codeup omits sourceProjectId even though the request supplied it).
  result: z
    .object({
      localId: z.number(),
      detailUrl: z.string().nullable().optional(),
      webUrl: z.string().nullable().optional(),
    })
    .passthrough()
    .optional(),
});

const CodeupMergeResponseSchema = CodeupApiEnvelopeSchema.extend({
  result: z
    .object({
      result: z.boolean().optional(),
      localId: z.number().optional(),
    })
    .passthrough()
    .optional(),
});

type CodeupApiEnvelope = z.infer<typeof CodeupApiEnvelopeSchema>;
type CodeupRepository = z.infer<typeof CodeupRepositorySchema>;
type CodeupMergeRequestListItem = z.infer<typeof CodeupMergeRequestListItemSchema>;
type CodeupMergeRequestDetail = z.infer<typeof CodeupMergeRequestDetailSchema>;
type CodeupCheckRun = z.infer<typeof CodeupCheckRunSchema>;
type CodeupCommitStatus = z.infer<typeof CodeupCommitStatusSchema>;
type CodeupComment = z.infer<typeof CodeupCommentSchema>;

interface CodeupRepositoryContext {
  organizationId: string;
  repositoryIdentity: string;
  remoteTransport: GitRemoteLocation["transport"];
  repository: CodeupRepository;
}

const aliyunCliRunner = createForgeCliRunner({
  binary: "aliyun",
  envOverlay: ALIYUN_ENV,
  timeoutMs: ALIYUN_COMMAND_TIMEOUT_MS,
  isAuthFailureText,
  errorClasses: {
    isAlreadyClassified: (candidate) =>
      candidate instanceof AliyunAuthenticationError || candidate instanceof AliyunCliMissingError,
    isCommandError: (candidate): candidate is AliyunCommandError =>
      candidate instanceof AliyunCommandError,
    createAuthError: (stderr) => new AliyunAuthenticationError({ stderr }),
    createMissingError: () => new AliyunCliMissingError(),
    createCommandError: (params) => new AliyunCommandError(params),
  },
});

async function runAliyunCommand(
  args: string[],
  options: CodeupCommandRunnerOptions,
): Promise<CodeupCommandResult> {
  return aliyunCliRunner.run(args, options);
}

async function resolveAliyunPath(): Promise<string | null> {
  return findExecutable("aliyun");
}

export function parseCodeupRemoteIdentity(remoteUrl: string): CodeupRemoteIdentity | null {
  const location = parseGitRemoteLocation(remoteUrl);
  if (!location || location.host !== CODEUP_HOST) {
    return null;
  }
  const segments = location.path.split("/").filter(Boolean);
  const organizationId = segments.shift();
  if (!organizationId || segments.length === 0) {
    return null;
  }
  return { organizationId, repositoryIdentity: location.path };
}

function isAuthFailureText(text: string): boolean {
  return /\b(InvalidAccessKeyId|SignatureDoesNotMatch|InvalidSecurityToken|MissingAccessKeyId|ExpiredSecurityToken|AuthFailure|Unauthorized|not configure(?:d)?|configuration failed)\b/i.test(
    text,
  );
}

function isNoPermissionText(text: string): boolean {
  return /\b(403|forbidden|no.?permission|access.?denied|Forbidden\.RAM)\b/i.test(text);
}

function isNotFoundText(text: string): boolean {
  return /\b(404|not.?found|repositorynotfound|mergerequestnotfound)\b/i.test(text);
}

function apiArgs(action: string, parameters: ReadonlyArray<readonly [string, string]>): string[] {
  // The official aliyun CLI's built-in `devops` metadata selects 2021-06-25.
  // Passing --version explicitly makes v3.4.8 reject the command as an
  // "unchecked version", even with the otherwise valid fixed endpoint.
  const args = [
    "--region",
    CODEUP_REGION,
    "--endpoint",
    CODEUP_ENDPOINT,
    "--language",
    "en",
    "devops",
    action,
  ];
  for (const [name, value] of parameters) {
    args.push(`--${name}`, value);
  }
  return args;
}

function apiErrorText(response: CodeupApiEnvelope): string {
  return [response.errorCode, response.errorMessage]
    .filter((value) => value !== null && value !== undefined && String(value).length > 0)
    .join(": ");
}

function mapListState(state: string): string {
  if (["opened", "reopened", "accepted", "locked"].includes(state)) return "open";
  if (state === "merged") return "merged";
  return "closed";
}

function mapDetailState(status: string): string {
  if (status === "MERGED") return "merged";
  if (status === "CLOSED") return "closed";
  return "open";
}

function detailUrl(mr: { detailUrl?: string | null; webUrl?: string | null }): string {
  return mr.detailUrl?.trim() || mr.webUrl?.trim() || "";
}

function listItemToSummary(mr: CodeupMergeRequestListItem): PullRequestSummary {
  return {
    number: mr.localId,
    title: mr.title,
    url: detailUrl(mr),
    state: mapListState(mr.state),
    body: mr.description ?? null,
    ...(mr.nameWithNamespace ? { projectPath: mr.nameWithNamespace } : {}),
    baseRefName: mr.targetBranch,
    headRefName: mr.sourceBranch,
    labels: (mr.labels ?? []).map((label) => label.name),
    updatedAt: mr.updatedAt ?? "",
  };
}

function toSearchChangeRequest(mr: PullRequestSummary): SearchResult["items"][number] {
  const item: SearchResult["items"][number] = {
    kind: "change_request",
    forge: "codeup",
    number: mr.number,
    title: mr.title,
    url: mr.url,
    state: mr.state,
    body: mr.body,
    labels: mr.labels,
    baseRefName: mr.baseRefName,
    headRefName: mr.headRefName,
    updatedAt: mr.updatedAt,
  };
  if (mr.projectPath) item.projectPath = mr.projectPath;
  return item;
}

function detailToSummary(mr: CodeupMergeRequestDetail, projectPath?: string): PullRequestSummary {
  return {
    number: mr.localId,
    title: mr.title,
    url: detailUrl(mr),
    state: mapDetailState(mr.status),
    body: mr.description ?? null,
    ...(projectPath ? { projectPath } : {}),
    baseRefName: mr.targetBranch,
    headRefName: mr.sourceBranch,
    labels: [],
    updatedAt: mr.updateTime ?? "",
  };
}

function toRequirementChecks(mr: CodeupMergeRequestDetail): CodeupRequirementChecks {
  const byType = new Map(
    (mr.todoList?.requirementCheckItems ?? []).map((item) => [item.itemType, item.pass]),
  );
  return {
    mergeConflict: byType.get("MERGE_CONFLICT_CHECK") ?? null,
    comments: byType.get("COMMENTS_CHECK") ?? null,
    ci: byType.get("CI_CHECK") ?? null,
    reviewerApproved: byType.get("REVIEWER_APPROVED_CHECK") ?? null,
  };
}

function toStatusFacts(mr: CodeupMergeRequestDetail): CodeupStatusFacts {
  return {
    status: mr.status,
    allRequirementsPass: mr.allRequirementsPass ?? false,
    requirementChecks: toRequirementChecks(mr),
  };
}

function mapMergeable(mr: CodeupMergeRequestDetail): PullRequestMergeable {
  const facts = toStatusFacts(mr);
  if (facts.requirementChecks.mergeConflict === false) {
    return "CONFLICTING";
  }
  return isCodeupDirectMergeReady(facts) ? "MERGEABLE" : "UNKNOWN";
}

function mapReviewDecision(
  reviewers: z.infer<typeof CodeupUserSchema>[] | undefined,
): CurrentPullRequestStatus["reviewDecision"] {
  if (!reviewers || reviewers.length === 0) return null;
  if (reviewers.some((reviewer) => reviewer.reviewOpinionStatus === "NOT_PASS")) {
    return "changes_requested";
  }
  if (
    reviewers.every(
      (reviewer) => reviewer.hasReviewed === true && reviewer.reviewOpinionStatus === "PASS",
    )
  ) {
    return "approved";
  }
  return "pending";
}

function mapCheckRunStatus(check: CodeupCheckRun): PullRequestCheck["status"] {
  if (check.status !== "completed") return "pending";
  switch (check.conclusion) {
    case "success":
    case "neutral":
      return "success";
    case "failure":
    case "timed_out":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

function mapCommitStatus(status: string): PullRequestCheck["status"] {
  switch (status) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    default:
      return "pending";
  }
}

function formatDuration(
  startedAt?: string | null,
  completedAt?: string | null,
): string | undefined {
  const start = parseOptionalTime(startedAt);
  const end = parseOptionalTime(completedAt);
  if (start <= 0 || end <= start) return undefined;
  const seconds = Math.floor((end - start) / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remaining}s` : `${remaining}s`;
}

function toPullRequestCheck(check: CodeupCheckRun): PullRequestCheck {
  const duration = formatDuration(check.startedAt, check.completedAt);
  return {
    name: check.name,
    status: mapCheckRunStatus(check),
    url: check.detailsUrl ?? null,
    checkRunId: check.id,
    ...(duration ? { duration } : {}),
  };
}

function toCommitStatusCheck(status: CodeupCommitStatus): PullRequestCheck {
  return {
    name: status.context?.trim() || "Commit status",
    status: mapCommitStatus(status.state),
    url: status.targetUrl ?? null,
  };
}

function splitProjectPath(projectPath: string): { owner?: string; name?: string } {
  const segments = projectPath.split("/").filter(Boolean);
  if (segments.length === 0) return {};
  return { owner: segments[0], name: segments[segments.length - 1] };
}

function toCurrentStatus(
  mr: CodeupMergeRequestDetail,
  repository: CodeupRepository,
  checks: PullRequestCheck[],
): CurrentPullRequestStatus {
  const projectPath = repository.pathWithNamespace;
  const { owner, name } = splitProjectPath(projectPath);
  return {
    number: mr.localId,
    ...(owner ? { repoOwner: owner } : {}),
    ...(name ? { repoName: name } : {}),
    projectPath,
    url: detailUrl(mr),
    title: mr.title,
    state: mapDetailState(mr.status),
    baseRefName: mr.targetBranch,
    headRefName: mr.sourceBranch,
    isMerged: mr.status === "MERGED",
    isDraft: mr.status === "UNDER_DEV",
    mergeable: mapMergeable(mr),
    checks,
    checksStatus: computeChecksStatus(checks),
    reviewDecision: mapReviewDecision(mr.reviewers),
    forgeSpecific: { forge: "codeup", ...toStatusFacts(mr) },
  };
}

function mapTimelineError(error: unknown): PullRequestTimelineError {
  let message: string;
  if (error instanceof AliyunCommandError) {
    message = error.stderr || error.message;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  if (isNotFoundText(message)) return { kind: "not_found", message };
  if (isNoPermissionText(message) || error instanceof AliyunAuthenticationError) {
    return { kind: "forbidden", message };
  }
  return { kind: "unknown", message };
}

function reviewTimelineItems(mr: CodeupMergeRequestDetail, url: string): PullRequestTimelineItem[] {
  return (mr.reviewers ?? []).flatMap((reviewer) => {
    if (reviewer.hasReviewed !== true || !reviewer.reviewTime) return [];
    let reviewState: "approved" | "changes_requested" | "commented" = "commented";
    if (reviewer.reviewOpinionStatus === "PASS") {
      reviewState = "approved";
    } else if (reviewer.reviewOpinionStatus === "NOT_PASS") {
      reviewState = "changes_requested";
    }
    const author = reviewer.username ?? reviewer.name ?? "unknown";
    return [
      {
        kind: "review" as const,
        id: `review:${reviewer.id ?? author}:${reviewer.reviewTime}`,
        author,
        authorUrl: null,
        avatarUrl: reviewer.avatarUrl ?? null,
        body: "",
        createdAt: parseOptionalTime(reviewer.reviewTime),
        url,
        reviewState,
      },
    ];
  });
}

function parseComment(value: unknown): CodeupComment | null {
  const parsed = CodeupCommentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toCommentLocation(
  comment: CodeupComment,
  threadId: string,
): PullRequestTimelineCommentLocation | undefined {
  if (!comment.filePath) return undefined;
  const line = Number.parseInt(comment.lineNumber ?? "", 10);
  const location: PullRequestTimelineCommentLocation = {
    path: comment.filePath,
    threadId,
  };
  if (Number.isFinite(line) && line > 0) location.line = line;
  if (comment.resolved !== undefined) location.isResolved = comment.resolved;
  return location;
}

function toCommentTimelineItem(input: {
  comment: CodeupComment;
  url: string;
  threadId: string;
  belongsToThread: boolean;
}): PullRequestTimelineItem | null {
  const { comment } = input;
  if (comment.deleted === true || comment.commentType?.includes("SYSTEM")) return null;
  const item: Extract<PullRequestTimelineItem, { kind: "comment" }> = {
    kind: "comment",
    id: comment.commentBizId,
    author: comment.author?.username ?? comment.author?.name ?? "unknown",
    authorUrl: null,
    avatarUrl: comment.author?.avatarUrl ?? null,
    body: comment.content ?? "",
    createdAt: parseOptionalTime(comment.commentTime),
    url: input.url,
  };
  if (input.belongsToThread) item.threadId = input.threadId;
  const location = toCommentLocation(comment, input.threadId);
  if (location) {
    item.location = location;
  } else if (comment.resolved !== undefined) {
    item.threadIsResolved = comment.resolved;
  }
  return item;
}

function commentTimelineItems(rawComments: unknown[], url: string): PullRequestTimelineItem[] {
  const items: PullRequestTimelineItem[] = [];

  function visit(value: unknown, rootId?: string, groupSize = 1): void {
    const comment = parseComment(value);
    if (!comment) return;
    const children = [...(comment.childComments ?? []), ...(comment.finalChildComments ?? [])];
    const resolvedRootId = rootId ?? comment.rootCommentBizId ?? comment.commentBizId;
    const item = toCommentTimelineItem({
      comment,
      url,
      threadId: resolvedRootId,
      belongsToThread:
        groupSize > 1 ||
        children.length > 0 ||
        Boolean(comment.parentCommentBizId || comment.rootCommentBizId),
    });
    if (item) items.push(item);
    for (const child of children) {
      visit(child, resolvedRootId, Math.max(groupSize, children.length + 1));
    }
  }

  for (const comment of rawComments) visit(comment);
  return items;
}

function assertDirectMergeReady(input: Pick<MergePullRequestOptions, "status">): void {
  const facts = parseCodeupStatusFacts(input.status?.forgeSpecific);
  if (!facts) {
    throw new Error("Codeup merge facts are unavailable for this merge request");
  }
  if (!isCodeupDirectMergeReady(facts)) {
    throw new Error("Codeup does not report this merge request as ready for direct merge");
  }
}

function notSupported(method: string): never {
  throw new Error(`${method} is not supported on Codeup`);
}

export function createCodeupService(options: CreateCodeupServiceOptions = {}): ForgeService {
  const runner = options.runner ?? runAliyunCommand;
  const resolveAliyun = createCachedCliPathResolver(options.resolveAliyunPath ?? resolveAliyunPath);
  const resolveRemoteUrl = options.resolveRemoteUrl ?? defaultResolveRemoteUrl;
  const repositoryContextByCwd = new Map<string, Promise<CodeupRepositoryContext>>();
  const repositoryByIdentity = new Map<string, Promise<CodeupRepository>>();

  async function run(args: string[], runOptions: CodeupCommandRunnerOptions): Promise<string> {
    const aliyunPath = await resolveAliyun();
    if (!aliyunPath) throw new AliyunCliMissingError();
    try {
      const result = await runner(args, { ...runOptions, binaryPath: aliyunPath });
      return result.stdout.trim();
    } catch (error) {
      throw aliyunCliRunner.normalizeError(error, { args, cwd: runOptions.cwd });
    }
  }

  async function runJson<T>(args: string[], cwd: string, schema: z.ZodType<T>): Promise<T> {
    const stdout = await run(args, { cwd });
    const parsed = parseCliJsonOutput({
      commandName: "aliyun",
      args,
      cwd,
      stdout,
      schema,
      createCommandError: (params) => new AliyunCommandError(params),
    });
    const envelope = CodeupApiEnvelopeSchema.safeParse(parsed);
    if (envelope.success && envelope.data.success === false) {
      const stderr = apiErrorText(envelope.data) || "Codeup API returned success=false";
      if (isAuthFailureText(stderr)) {
        throw new AliyunAuthenticationError({ stderr });
      }
      throw new AliyunCommandError({ args, cwd, exitCode: 0, stderr });
    }
    return parsed;
  }

  async function runApiJson<T>(
    action: string,
    parameters: ReadonlyArray<readonly [string, string]>,
    cwd: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return runJson(apiArgs(action, parameters), cwd, schema);
  }

  async function loadRepository(
    cwd: string,
    organizationId: string,
    identity: string,
  ): Promise<CodeupRepository> {
    const cacheKey = `${organizationId}:${identity}`;
    let pending = repositoryByIdentity.get(cacheKey);
    if (!pending) {
      pending = runApiJson(
        "GetRepository",
        [
          ["organizationId", organizationId],
          ["identity", identity],
        ],
        cwd,
        CodeupGetRepositoryResponseSchema,
      )
        .then((response) => {
          if (!response.repository) {
            throw new Error(`Codeup repository was not returned for ${identity}`);
          }
          return response.repository;
        })
        .catch((error: unknown) => {
          repositoryByIdentity.delete(cacheKey);
          throw error;
        });
      repositoryByIdentity.set(cacheKey, pending);
    }
    return pending;
  }

  async function getRepositoryContext(cwd: string): Promise<CodeupRepositoryContext> {
    let pending = repositoryContextByCwd.get(cwd);
    if (!pending) {
      pending = (async () => {
        const remoteUrl = await resolveRemoteUrl(cwd);
        const remoteLocation = remoteUrl ? parseGitRemoteLocation(remoteUrl) : null;
        const identity = remoteUrl ? parseCodeupRemoteIdentity(remoteUrl) : null;
        if (!identity || !remoteLocation) {
          throw new Error("Codeup remote must include organization id and repository path");
        }
        const repository = await loadRepository(
          cwd,
          identity.organizationId,
          identity.repositoryIdentity,
        );
        return { ...identity, remoteTransport: remoteLocation.transport, repository };
      })().catch((error: unknown) => {
        repositoryContextByCwd.delete(cwd);
        throw error;
      });
      repositoryContextByCwd.set(cwd, pending);
    }
    return pending;
  }

  async function listMergeRequestPage(
    input: {
      cwd: string;
      state: "opened" | "closed" | "merged" | "all";
      query?: string;
      page: number;
      pageSize: number;
    },
    context: CodeupRepositoryContext,
  ): Promise<{ items: CodeupMergeRequestListItem[]; total: number | undefined }> {
    const parameters: Array<readonly [string, string]> = [
      ["organizationId", context.organizationId],
      ["projectIds", String(context.repository.id)],
      ["state", input.state],
      ["filter", "new"],
      ["orderBy", "updated_at"],
      ["sort", "desc"],
      ["page", String(input.page)],
      ["pageSize", String(input.pageSize)],
    ];
    if (input.query?.trim()) parameters.push(["search", input.query.trim()]);
    const response = await runApiJson(
      "ListMergeRequests",
      parameters,
      input.cwd,
      CodeupListMergeRequestsResponseSchema,
    );
    return { items: response.result ?? [], total: response.total };
  }

  async function listMergeRequests(input: {
    cwd: string;
    state: "opened" | "closed" | "merged" | "all";
    query?: string;
    limit?: number;
  }): Promise<CodeupMergeRequestListItem[]> {
    const context = await getRepositoryContext(input.cwd);
    const requestedLimit = Math.max(1, input.limit ?? 20);
    const items: CodeupMergeRequestListItem[] = [];
    const seenFullPageFingerprints = new Set<string>();
    let page = 1;
    while (items.length < requestedLimit) {
      const pageSize = CODEUP_PAGE_SIZE;
      const response = await listMergeRequestPage({ ...input, page, pageSize }, context);
      const pageItems = response.items;
      assertCodeupPageProgress({
        itemCount: pageItems.length,
        pageSize,
        pageKeys: pageItems.map((item) => String(item.localId)),
        seenFullPageFingerprints,
      });
      items.push(...pageItems);
      if (items.length >= requestedLimit) break;
      const hasNextPage = hasNextCodeupPage({
        itemCount: pageItems.length,
        pageSize,
        page,
        visited: items.length,
        total: response.total,
      });
      if (!hasNextPage) break;
      page += 1;
    }
    return items.slice(0, requestedLimit);
  }

  async function getMergeRequest(
    cwd: string,
    number: number,
    existingContext?: CodeupRepositoryContext,
  ): Promise<CodeupMergeRequestDetail> {
    const context = existingContext ?? (await getRepositoryContext(cwd));
    const response = await runApiJson(
      "GetMergeRequest",
      [
        ["organizationId", context.organizationId],
        ["repositoryId", String(context.repository.id)],
        ["localId", String(number)],
      ],
      cwd,
      CodeupGetMergeRequestResponseSchema,
    );
    if (!response.result) throw new Error(`Codeup merge request !${number} was not returned`);
    return response.result;
  }

  async function getLatestSourceSha(
    cwd: string,
    context: CodeupRepositoryContext,
    number: number,
  ): Promise<string | null> {
    const response = await runApiJson(
      "ListMergeRequestPatchSets",
      [
        ["organizationId", context.organizationId],
        ["repositoryIdentity", String(context.repository.id)],
        ["localId", String(number)],
      ],
      cwd,
      CodeupListPatchSetsResponseSchema,
    );
    return (
      (response.result ?? [])
        .filter((patch) => patch.relatedMergeItemType === "MERGE_SOURCE" && patch.commitId)
        .sort((left, right) => (right.patchSetNo ?? 0) - (left.patchSetNo ?? 0))[0]?.commitId ??
      null
    );
  }

  async function listCheckRuns(
    cwd: string,
    context: CodeupRepositoryContext,
    sha: string,
  ): Promise<CodeupCheckRun[]> {
    const items: CodeupCheckRun[] = [];
    const seenFullPageFingerprints = new Set<string>();
    let page = 1;
    while (true) {
      const response = await runApiJson(
        "ListCheckRuns",
        [
          ["organizationId", context.organizationId],
          ["repositoryIdentity", String(context.repository.id)],
          ["ref", sha],
          ["page", String(page)],
          ["pageSize", String(CODEUP_PAGE_SIZE)],
        ],
        cwd,
        CodeupListCheckRunsResponseSchema,
      );
      const pageItems = response.result ?? [];
      assertCodeupPageProgress({
        itemCount: pageItems.length,
        pageSize: CODEUP_PAGE_SIZE,
        pageKeys: pageItems.map((item) => String(item.id)),
        seenFullPageFingerprints,
      });
      items.push(...pageItems);
      const hasNextPage = hasNextCodeupPage({
        itemCount: pageItems.length,
        pageSize: CODEUP_PAGE_SIZE,
        page,
        visited: items.length,
        total: response.total,
      });
      if (!hasNextPage) break;
      page += 1;
    }
    return items;
  }

  async function listCommitStatuses(
    cwd: string,
    context: CodeupRepositoryContext,
    sha: string,
  ): Promise<CodeupCommitStatus[]> {
    const items: CodeupCommitStatus[] = [];
    const seenFullPageFingerprints = new Set<string>();
    let page = 1;
    while (true) {
      const response = await runApiJson(
        "ListCommitStatuses",
        [
          ["organizationId", context.organizationId],
          ["repositoryIdentity", String(context.repository.id)],
          ["sha", sha],
          ["page", String(page)],
          ["pageSize", String(CODEUP_PAGE_SIZE)],
        ],
        cwd,
        CodeupListCommitStatusesResponseSchema,
      );
      const pageItems = response.result ?? [];
      assertCodeupPageProgress({
        itemCount: pageItems.length,
        pageSize: CODEUP_PAGE_SIZE,
        pageKeys: pageItems.map((item) =>
          item.id === undefined
            ? JSON.stringify([item.context, item.state, item.targetUrl])
            : String(item.id),
        ),
        seenFullPageFingerprints,
      });
      items.push(...pageItems);
      const hasNextPage = hasNextCodeupPage({
        itemCount: pageItems.length,
        pageSize: CODEUP_PAGE_SIZE,
        page,
        visited: items.length,
        total: response.total,
      });
      if (!hasNextPage) break;
      page += 1;
    }
    return items;
  }

  async function loadChecks(
    cwd: string,
    context: CodeupRepositoryContext,
    sha: string | null,
  ): Promise<PullRequestCheck[]> {
    if (!sha) return [];
    const [runs, statuses] = await Promise.all([
      listCheckRuns(cwd, context, sha),
      listCommitStatuses(cwd, context, sha),
    ]);
    return [...runs.map(toPullRequestCheck), ...statuses.map(toCommitStatusCheck)];
  }

  async function sourceRepositoryMatches(
    cwd: string,
    context: CodeupRepositoryContext,
    candidate: CodeupMergeRequestListItem,
    headRepositoryOwner?: string,
  ): Promise<boolean> {
    if (!headRepositoryOwner) return candidate.sourceProjectId === context.repository.id;
    const source = await loadRepository(
      cwd,
      context.organizationId,
      String(candidate.sourceProjectId),
    );
    return source.pathWithNamespace === headRepositoryOwner;
  }

  async function resolveCurrentMergeRequest(input: {
    cwd: string;
    headRef: string;
    headSha?: string;
    headRepositoryOwner?: string;
  }): Promise<{ detail: CodeupMergeRequestDetail; sha: string | null } | null> {
    const context = await getRepositoryContext(input.cwd);
    const seenFullPageFingerprints = new Set<string>();
    let page = 1;
    let visited = 0;
    while (true) {
      const response = await listMergeRequestPage(
        { cwd: input.cwd, state: "all", page, pageSize: CODEUP_PAGE_SIZE },
        context,
      );
      assertCodeupPageProgress({
        itemCount: response.items.length,
        pageSize: CODEUP_PAGE_SIZE,
        pageKeys: response.items.map((item) => String(item.localId)),
        seenFullPageFingerprints,
      });
      for (const candidate of response.items) {
        if (
          candidate.sourceBranch !== input.headRef ||
          candidate.targetProjectId !== context.repository.id
        ) {
          continue;
        }
        if (
          !(await sourceRepositoryMatches(input.cwd, context, candidate, input.headRepositoryOwner))
        ) {
          continue;
        }
        const state = mapListState(candidate.state);
        if (state === "open") {
          return {
            detail: await getMergeRequest(input.cwd, candidate.localId, context),
            sha: await getLatestSourceSha(input.cwd, context, candidate.localId),
          };
        }
        if (!input.headSha) continue;
        const sha = await getLatestSourceSha(input.cwd, context, candidate.localId);
        if (sha === input.headSha) {
          return { detail: await getMergeRequest(input.cwd, candidate.localId, context), sha };
        }
      }
      visited += response.items.length;
      const hasNextPage = hasNextCodeupPage({
        itemCount: response.items.length,
        pageSize: CODEUP_PAGE_SIZE,
        page,
        visited,
        total: response.total,
      });
      if (!hasNextPage) break;
      page += 1;
    }
    return null;
  }

  return {
    authProbeCanThrow: true,

    async isAuthenticated(input: { cwd: string } & ForgeReadOptions): Promise<boolean> {
      await run(["--language", "en", "sts", "GetCallerIdentity"], { cwd: input.cwd });
      return true;
    },

    async getCurrentPullRequestStatus(input): Promise<CurrentPullRequestStatus | null> {
      const current = await resolveCurrentMergeRequest(input);
      if (!current) return null;
      const context = await getRepositoryContext(input.cwd);
      const checks = await loadChecks(input.cwd, context, current.sha);
      return toCurrentStatus(current.detail, context.repository, checks);
    },

    async getPullRequest(input: GetPullRequestOptions): Promise<PullRequestSummary> {
      const context = await getRepositoryContext(input.cwd);
      return detailToSummary(
        await getMergeRequest(input.cwd, input.number, context),
        context.repository.pathWithNamespace,
      );
    },

    async getPullRequestHeadRef(input: GetPullRequestOptions): Promise<string> {
      return (await getMergeRequest(input.cwd, input.number)).sourceBranch;
    },

    async getPullRequestCheckoutTarget(
      input: GetPullRequestOptions,
    ): Promise<PullRequestCheckoutTarget> {
      const context = await getRepositoryContext(input.cwd);
      const mr = await getMergeRequest(input.cwd, input.number, context);
      const isCrossRepository = mr.sourceProjectId !== mr.targetProjectId;
      const sourceRepository = isCrossRepository
        ? await loadRepository(input.cwd, context.organizationId, String(mr.sourceProjectId))
        : context.repository;
      const sourceRemoteUrl = ["http", "https"].includes(context.remoteTransport)
        ? (sourceRepository.httpUrlToRepository ?? sourceRepository.sshUrlToRepository ?? null)
        : (sourceRepository.sshUrlToRepository ?? sourceRepository.httpUrlToRepository ?? null);
      if (isCrossRepository && !sourceRemoteUrl) {
        throw new Error("Codeup did not return a clone URL for the source repository");
      }
      return {
        number: mr.localId,
        baseRefName: mr.targetBranch,
        headRefName: mr.sourceBranch,
        checkoutRefs: [
          {
            ...(isCrossRepository && sourceRemoteUrl ? { remoteUrl: sourceRemoteUrl } : {}),
            remoteName: "origin",
            remoteRef: `refs/heads/${mr.sourceBranch}`,
          },
        ],
        headOwnerLogin: isCrossRepository ? sourceRepository.pathWithNamespace : null,
        ...(isCrossRepository && sourceRemoteUrl ? { preferredPushUrl: sourceRemoteUrl } : {}),
        headRepositorySshUrl: sourceRepository.sshUrlToRepository ?? null,
        headRepositoryUrl: sourceRepository.httpUrlToRepository ?? null,
        isCrossRepository,
      };
    },

    async listPullRequests(input: ListPullRequestsOptions): Promise<PullRequestSummary[]> {
      return (
        await listMergeRequests({
          cwd: input.cwd,
          state: "opened",
          query: input.query,
          limit: input.limit,
        })
      ).map(listItemToSummary);
    },

    async listIssues(_input: ListIssuesOptions): Promise<IssueSummary[]> {
      return [];
    },

    async createPullRequest(input: CreatePullRequestOptions): Promise<PullRequestCreateResult> {
      const context = await getRepositoryContext(input.cwd);
      const response = await runApiJson(
        "CreateMergeRequest",
        [
          ["organizationId", context.organizationId],
          ["repositoryId", String(context.repository.id)],
          [
            "body",
            JSON.stringify({
              sourceProjectId: context.repository.id,
              sourceBranch: input.head,
              targetProjectId: context.repository.id,
              targetBranch: input.base,
              title: input.title,
              createFrom: "WEB",
              description: input.body ?? "",
            }),
          ],
        ],
        input.cwd,
        CodeupCreateMergeRequestResponseSchema,
      );
      if (!response.result) throw new Error("Codeup did not return the created merge request");
      let url = detailUrl(response.result);
      if (!url) {
        url = detailUrl(await getMergeRequest(input.cwd, response.result.localId, context));
      }
      if (!url) throw new Error("Codeup merge request was created but no URL was returned");
      return { url, number: response.result.localId };
    },

    async mergePullRequest(input: MergePullRequestOptions): Promise<PullRequestMergeResult> {
      assertDirectMergeReady(input);
      const context = await getRepositoryContext(input.cwd);
      const mergeType = input.mergeMethod === "merge" ? "no-fast-forward" : input.mergeMethod;
      const response = await runApiJson(
        "MergeMergeRequest",
        [
          ["organizationId", context.organizationId],
          ["repositoryId", String(context.repository.id)],
          ["localId", String(input.prNumber)],
          ["body", JSON.stringify({ mergeType, removeSourceBranch: false })],
        ],
        input.cwd,
        CodeupMergeResponseSchema,
      );
      if (response.result?.result !== true) {
        throw new Error("Codeup did not confirm that the merge request was merged");
      }
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
        const context = await getRepositoryContext(input.cwd);
        const mr = await getMergeRequest(input.cwd, input.prNumber, context);
        const url = detailUrl(mr);
        const reviews = reviewTimelineItems(mr, url);
        try {
          const response = await runApiJson(
            "ListMergeRequestComments",
            [
              ["organizationId", context.organizationId],
              ["repositoryIdentity", String(context.repository.id)],
              ["localId", String(input.prNumber)],
            ],
            input.cwd,
            CodeupListCommentsResponseSchema,
          );
          return {
            ...identity,
            items: [...reviews, ...commentTimelineItems(response.result ?? [], url)].sort(
              compareTimelineItems,
            ),
            truncated: false,
            error: null,
          };
        } catch (error) {
          return {
            ...identity,
            items: reviews.sort(compareTimelineItems),
            truncated: false,
            error: mapTimelineError(error),
          };
        }
      } catch (error) {
        return { ...identity, items: [], truncated: false, error: mapTimelineError(error) };
      }
    },

    async getCheckDetails(input: GetCheckDetailsOptions): Promise<CheckDetails> {
      if (input.checkRunId === undefined) {
        throw new Error("Codeup check details require a checkRunId");
      }
      const context = await getRepositoryContext(input.cwd);
      const response = await runApiJson(
        "GetCheckRun",
        [
          ["organizationId", context.organizationId],
          ["repositoryIdentity", String(context.repository.id)],
          ["checkRunId", String(input.checkRunId)],
        ],
        input.cwd,
        CodeupGetCheckRunResponseSchema,
      );
      const check = response.result;
      if (!check) throw new Error(`Codeup check run ${input.checkRunId} was not returned`);
      return {
        checkRunId: check.id,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion ?? null,
        url: check.detailsUrl ?? null,
        detailsUrl: check.detailsUrl ?? null,
        output: check.output ?? null,
        annotations: check.annotations ?? [],
        failedJobs: [],
        truncated: false,
      };
    },

    async searchIssuesAndPrs(input: SearchIssuesAndPrsOptions): Promise<SearchResult> {
      if (input.force && !input.reason) {
        throw new Error("ForgeService forced read requires a reason");
      }
      const kinds = normalizeForgeSearchKinds(input.kinds);
      try {
        if (!kinds.includes("change_request")) {
          await this.isAuthenticated({ cwd: input.cwd });
          return {
            items: [],
            featuresEnabled: true,
            authState: "authenticated",
            githubFeaturesEnabled: true,
          };
        }
        const mergeRequests = await listMergeRequests({
          cwd: input.cwd,
          state: "opened",
          query: input.query,
          limit: input.limit,
        });
        return {
          items: mergeRequests
            .map(listItemToSummary)
            .map(toSearchChangeRequest)
            .sort(
              (left, right) =>
                parseOptionalTime(right.updatedAt) - parseOptionalTime(left.updatedAt),
            ),
          featuresEnabled: true,
          authState: "authenticated",
          githubFeaturesEnabled: true,
        };
      } catch (error) {
        if (error instanceof AliyunCliMissingError) {
          return createUnavailableSearchResult("cli_missing");
        }
        if (error instanceof AliyunAuthenticationError) {
          return createUnavailableSearchResult("unauthenticated");
        }
        throw error;
      }
    },

    enablePullRequestAutoMerge(
      _input: EnablePullRequestAutoMergeOptions,
    ): Promise<PullRequestAutoMergeResult> {
      return notSupported("enablePullRequestAutoMerge");
    },

    disablePullRequestAutoMerge(
      _input: DisablePullRequestAutoMergeOptions,
    ): Promise<PullRequestAutoMergeResult> {
      return notSupported("disablePullRequestAutoMerge");
    },

    invalidate(input: { cwd: string }): void {
      repositoryContextByCwd.delete(input.cwd);
      repositoryByIdentity.clear();
    },
  };
}
