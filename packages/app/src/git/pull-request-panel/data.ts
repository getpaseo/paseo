import type {
  CheckoutPrStatusResponse,
  PullRequestTimelineResponse,
} from "@getpaseo/protocol/messages";
import { type Forge, getForgePresentation } from "@/git/forge";
import { parseClientForgeFacts } from "@/git/forges";
import type { ForgeSpecificStatusFacts } from "@/git/merge-capability";
import { type CheckStatus, mapCheckStatus } from "./check-status";
import { getNativeFallbackChecks } from "./native-data";

export type { CheckStatus } from "./check-status";

export type PrState = "open" | "draft" | "merged" | "closed";
export type ReviewState = "approved" | "changes_requested" | "commented";
export type ActivityKind = "review" | "comment";
export type PullRequestProvider = Forge;

export interface PullRequestProviderMetadata {
  id: PullRequestProvider;
  label: string;
  url?: string | null;
}

export interface PrPaneCheck {
  provider: PullRequestProvider;
  name: string;
  workflow?: string;
  status: CheckStatus;
  duration?: string;
  url: string;
  /**
   * Forge-neutral reference for fetching this check's detail/logs on demand. Any
   * forge that exposes a check-run id populates it; the daemon resolves the logs
   * through the neutral check-details RPC.
   */
  detailRef?: {
    checkRunId?: number;
    workflowRunId?: number;
  };
}

export interface PrPaneActivity {
  provider: PullRequestProvider;
  id: string;
  kind: ActivityKind;
  author: string;
  authorUrl?: string | null;
  avatarColor: string;
  avatarUrl?: string | null;
  reviewState?: ReviewState;
  body: string;
  age: string;
  url: string;
  /** For inline review comments: the review this comment was submitted with. */
  reviewId?: string;
  /**
   * Forge-neutral discussion id, independent of a file position. Groups general
   * (non-file) reply chains into one thread; file threads also carry it.
   */
  threadId?: string;
  /**
   * Resolution state for a thread with no file position (e.g. a GitLab general
   * discussion). File threads carry resolution under `location.isResolved`.
   */
  threadIsResolved?: boolean;
  location?: {
    path: string;
    line?: number;
    startLine?: number;
    threadId?: string;
    isResolved?: boolean;
    isOutdated?: boolean;
  };
}

export interface PrPaneData {
  provider: PullRequestProviderMetadata;
  /** The forge hosting this change request. */
  forge: Forge;
  number: number;
  repoOwner?: string;
  repoName?: string;
  /** Neutral project identity (GitLab namespaces nest beyond owner/name). */
  projectPath?: string;
  title: string;
  state: PrState;
  url: string;
  reviewDecision: "approved" | "changes_requested" | "pending";
  awaitingReviewers: string[];
  checks: PrPaneCheck[];
  /**
   * The forge's already-validated native facts, passed through so pane native
   * contributions (e.g. GitLab pipeline/approvals) derive their surfaces without
   * the neutral data type carrying forge-specific fields.
   */
  forgeSpecific?: ForgeSpecificStatusFacts;
  activity: PrPaneActivity[];
}

type CheckoutPrStatus = CheckoutPrStatusResponse["payload"]["status"];
type PullRequestTimeline = PullRequestTimelineResponse["payload"];
type PullRequestTimelineItem = PullRequestTimeline["items"][number];

const AVATAR_COLORS = [
  "#8b5cf6",
  "#f97316",
  "#0ea5e9",
  "#10b981",
  "#ef4444",
  "#eab308",
  "#ec4899",
  "#6366f1",
];

export function mapPrPaneData(
  status: CheckoutPrStatus,
  timeline: PullRequestTimeline | null | undefined,
  nowMs = Date.now(),
  forge: Forge = "github",
): PrPaneData | null {
  if (!status) {
    return null;
  }

  const number = status.number ?? parsePullRequestNumber(status.url);
  if (number === null) {
    return null;
  }

  const timelineMatchesStatus = timeline?.prNumber === number;
  const provider = toProviderMetadata(forge);
  const forgeSpecific = parseClientForgeFacts(status.forgeSpecific);

  return {
    provider,
    forge,
    number,
    repoOwner: status.repoOwner,
    repoName: status.repoName,
    projectPath: status.projectPath,
    title: status.title,
    state: derivePrState(status),
    url: status.url,
    reviewDecision: mapReviewDecision(status.reviewDecision),
    // Requested reviewers are intentionally unwired until the server exposes them.
    awaitingReviewers: [],
    checks: mapChecks(status, forge),
    ...(forgeSpecific ? { forgeSpecific } : {}),
    activity: timelineMatchesStatus
      ? timeline.items.flatMap((item) => mapActivity(item, nowMs, forge))
      : [],
  };
}

function toProviderMetadata(forge: Forge): PullRequestProviderMetadata {
  return { id: forge, label: getForgePresentation(forge).brandLabel };
}

export function deriveAvatarColor(login: string): string {
  return AVATAR_COLORS[hashLogin(login) % AVATAR_COLORS.length];
}

export function formatAge(createdAtMs: number, nowMs = Date.now()): string {
  const elapsedMs = Math.max(0, nowMs - createdAtMs);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  if (elapsedSeconds < 60) {
    return "just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) {
    return `${elapsedDays}d ago`;
  }

  if (elapsedDays < 365) {
    return `${Math.floor(elapsedDays / 30)}mo ago`;
  }

  return `${Math.floor(elapsedDays / 365)}y ago`;
}

function derivePrState(status: NonNullable<CheckoutPrStatus>): PrState {
  if (status.isMerged || status.state === "merged") {
    return "merged";
  }
  if (status.state !== "open") {
    return "closed";
  }
  if (status.isDraft) {
    return "draft";
  }
  return "open";
}

function mapChecks(status: NonNullable<CheckoutPrStatus>, forge: Forge): PrPaneCheck[] {
  const checks = (status.checks ?? []).flatMap((check) => mapCheck(check, forge));
  if (checks.length > 0) {
    return checks;
  }
  return getNativeFallbackChecks(status, forge);
}

function mapCheck(
  check: NonNullable<CheckoutPrStatus>["checks"][number],
  forge: Forge,
): PrPaneCheck[] {
  if (check.url === null) {
    return [];
  }

  return [
    {
      provider: forge,
      name: check.name,
      status: mapCheckStatus(check.status),
      url: check.url,
      ...(check.workflow ? { workflow: check.workflow } : {}),
      ...(check.duration ? { duration: check.duration } : {}),
      ...(check.checkRunId !== undefined || check.workflowRunId !== undefined
        ? {
            detailRef: {
              ...(check.checkRunId !== undefined ? { checkRunId: check.checkRunId } : {}),
              ...(check.workflowRunId !== undefined ? { workflowRunId: check.workflowRunId } : {}),
            },
          }
        : {}),
    },
  ];
}

function mapActivity(item: PullRequestTimelineItem, nowMs: number, forge: Forge): PrPaneActivity[] {
  if (item.kind === "comment") {
    if (item.body.trim() === "") {
      return [];
    }
    return [
      {
        id: item.id,
        provider: forge,
        kind: "comment",
        author: item.author,
        authorUrl: item.authorUrl,
        avatarColor: deriveAvatarColor(item.author),
        avatarUrl: item.avatarUrl,
        body: item.body,
        age: formatAge(item.createdAt, nowMs),
        url: item.url,
        reviewId: item.reviewId,
        threadId: item.threadId,
        threadIsResolved: item.threadIsResolved,
        location: item.location,
      },
    ];
  }

  if (item.reviewState === "commented" && item.body.trim() === "") {
    return [];
  }

  return [
    {
      id: item.id,
      provider: forge,
      kind: "review",
      author: item.author,
      authorUrl: item.authorUrl,
      avatarColor: deriveAvatarColor(item.author),
      avatarUrl: item.avatarUrl,
      reviewState: item.reviewState,
      body: item.body,
      age: formatAge(item.createdAt, nowMs),
      url: item.url,
    },
  ];
}

function mapReviewDecision(
  reviewDecision: NonNullable<CheckoutPrStatus>["reviewDecision"],
): PrPaneData["reviewDecision"] {
  if (reviewDecision === "approved" || reviewDecision === "changes_requested") {
    return reviewDecision;
  }
  return "pending";
}

function parsePullRequestNumber(url: string): number | null {
  try {
    const match = new URL(url).pathname.match(/\/pull\/(\d+)(?:\/|$)/);
    if (!match) {
      return null;
    }

    const number = Number.parseInt(match[1], 10);
    return Number.isFinite(number) ? number : null;
  } catch {
    return null;
  }
}

function hashLogin(login: string): number {
  let hash = 0;
  for (const character of login.toLowerCase()) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function getStateLabel(state: PrState): string {
  if (state === "draft") return "Draft";
  if (state === "merged") return "Merged";
  if (state === "closed") return "Closed";
  return "Open";
}

export function getActivityVerb(item: Pick<PrPaneActivity, "kind" | "reviewState">): string {
  if (item.kind === "comment") return "Commented";
  if (item.reviewState === "approved") return "Approved";
  if (item.reviewState === "changes_requested") return "Requested changes";
  return "Reviewed";
}
