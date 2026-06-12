import type { CheckoutGithubCheckDetails } from "@getpaseo/protocol/messages";
import type { PullRequestContextAttachment } from "@/attachments/types";
import {
  formatPullRequestActivityLocation,
  formatPullRequestThreadPath,
} from "./activity-location";
import type { PrPaneActivity, PrPaneCheck, PullRequestProviderMetadata, ReviewState } from "./data";
import type { PrThreadEntry } from "./timeline";

export interface PullRequestContextMetadata {
  number: number;
  title: string;
  url: string;
}

export interface PullRequestContextBuilderInput {
  provider: PullRequestProviderMetadata;
  pullRequest: PullRequestContextMetadata;
  activity: PrPaneActivity;
}

export interface PullRequestThreadContextBuilderInput {
  provider: PullRequestProviderMetadata;
  pullRequest: PullRequestContextMetadata;
  thread: PrThreadEntry;
}

export interface PullRequestGithubCheckContextBuilderInput {
  provider: PullRequestProviderMetadata & { id: "github" };
  pullRequest: PullRequestContextMetadata;
  check: PrPaneCheck & { provider: "github" };
  githubDetails?: CheckoutGithubCheckDetails | null;
}

export function canAddPullRequestActivityToChat(activity: PrPaneActivity): boolean {
  if (activity.kind === "comment") {
    return activity.body.trim().length > 0;
  }
  return activity.body.trim().length > 0 || activity.reviewState === "changes_requested";
}

export function canAddPullRequestCheckLogsToChat(check: PrPaneCheck): boolean {
  return check.status === "failure";
}

export function buildPullRequestCommentContextAttachment(
  input: PullRequestContextBuilderInput,
): PullRequestContextAttachment {
  return {
    kind: "github.pull_request_comment",
    id: `${input.pullRequest.number}:${input.activity.id}`,
    title: input.activity.author,
    subtitle: formatPullRequestSubtitle(input.pullRequest),
    text: formatActivityContextText({
      ...input,
      heading: `${input.provider.label} pull request comment`,
    }),
    url: input.activity.url,
  };
}

export function buildPullRequestReviewContextAttachment(
  input: PullRequestContextBuilderInput,
): PullRequestContextAttachment | null {
  if (!canAddPullRequestActivityToChat(input.activity)) {
    return null;
  }

  return {
    kind: "github.pull_request_review",
    id: `${input.pullRequest.number}:${input.activity.id}`,
    title: input.activity.author,
    subtitle: formatPullRequestSubtitle(input.pullRequest),
    text: formatActivityContextText({
      ...input,
      heading: `${input.provider.label} pull request review`,
      reviewState: input.activity.reviewState,
    }),
    url: input.activity.url,
  };
}

/**
 * Attaches a whole review thread (root comment plus replies) as one
 * attachment, so the agent gets the full conversation around a code location.
 */
export function buildPullRequestThreadContextAttachment(
  input: PullRequestThreadContextBuilderInput,
): PullRequestContextAttachment | null {
  const comments = input.thread.comments.filter((comment) => comment.body.trim().length > 0);
  const root = input.thread.comments[0];
  if (comments.length === 0 || !root) {
    return null;
  }

  const lines = [
    `${input.provider.label} pull request review thread`,
    `Pull request: #${input.pullRequest.number} ${input.pullRequest.title}`,
    `Pull request URL: ${input.pullRequest.url}`,
    `URL: ${root.url}`,
    `Location: ${formatPullRequestThreadPath(input.thread.location)}`,
  ];
  if (input.thread.location.isResolved !== undefined) {
    lines.push(`Thread state: ${input.thread.location.isResolved ? "resolved" : "unresolved"}`);
  }
  if (input.thread.location.isOutdated) {
    lines.push("Note: this thread is outdated (the code it refers to has changed)");
  }

  const conversation = comments.map(
    (comment) => `${comment.author} (${comment.age}):\n${comment.body.trim()}`,
  );

  return {
    kind: "github.pull_request_comment",
    id: `${input.pullRequest.number}:${input.thread.id}`,
    title: formatPullRequestThreadPath(input.thread.location),
    subtitle: formatPullRequestSubtitle(input.pullRequest),
    text: [...lines, "", conversation.join("\n\n---\n\n")].join("\n"),
    url: root.url,
  };
}

export function buildPullRequestCheckContextAttachment(
  input: PullRequestGithubCheckContextBuilderInput,
): PullRequestContextAttachment {
  return {
    kind: "github.pull_request_check",
    id: formatPullRequestCheckContextId(input.pullRequest, input.check),
    title: input.check.name,
    subtitle: formatPullRequestSubtitle(input.pullRequest),
    text: formatGitHubCheckContextText(input),
    url: input.githubDetails?.detailsUrl ?? input.githubDetails?.url ?? input.check.url,
  };
}

function formatPullRequestCheckContextId(
  pullRequest: PullRequestContextMetadata,
  check: PrPaneCheck,
): string {
  if (check.github?.checkRunId !== undefined) {
    return `${pullRequest.number}:check-run:${check.github.checkRunId}`;
  }
  return `${pullRequest.number}:check:${check.name}`;
}

function formatGitHubCheckContextText({
  provider,
  pullRequest,
  check,
  githubDetails,
}: PullRequestGithubCheckContextBuilderInput): string {
  const lines = [
    `${provider.label} pull request check`,
    `Pull request: #${pullRequest.number} ${pullRequest.title}`,
    `Pull request URL: ${pullRequest.url}`,
    `Check: ${check.name}`,
    `Status: ${check.status}`,
  ];

  if (githubDetails?.conclusion) {
    lines.push(`Conclusion: ${githubDetails.conclusion}`);
  }
  lines.push(`Check URL: ${check.url}`);
  const detailsUrl = githubDetails?.detailsUrl ?? githubDetails?.url;
  if (detailsUrl) {
    lines.push(`Details URL: ${detailsUrl}`);
  }
  appendGitHubCheckOutput(lines, githubDetails);
  appendGitHubCheckAnnotations(lines, githubDetails);
  appendGitHubFailedJobs(lines, githubDetails);
  if (githubDetails?.truncated) {
    lines.push("", "Note: Check details were truncated by GitHub/API or local caps.");
  }

  return lines.join("\n");
}

function appendGitHubCheckOutput(
  lines: string[],
  details: CheckoutGithubCheckDetails | null | undefined,
) {
  if (details?.output?.title) {
    lines.push(`Output title: ${details.output.title}`);
  }
  if (details?.output?.summary) {
    lines.push(`Output summary: ${details.output.summary}`);
  }
  if (details?.output?.text) {
    lines.push("Output text:", details.output.text);
  }
}

function appendGitHubCheckAnnotations(
  lines: string[],
  details: CheckoutGithubCheckDetails | null | undefined,
) {
  if (!details?.annotations?.length) {
    return;
  }
  lines.push("", "Annotations:");
  for (const annotation of details.annotations) {
    lines.push(`- ${formatAnnotation(annotation)}`);
  }
}

function appendGitHubFailedJobs(
  lines: string[],
  details: CheckoutGithubCheckDetails | null | undefined,
) {
  if (!details?.failedJobs?.length) {
    return;
  }
  lines.push("", "Failed jobs:");
  for (const job of details.failedJobs) {
    lines.push(`- ${job.name}: ${job.conclusion ?? job.status ?? "unknown"}`);
    if (job.url) {
      lines.push(`  ${job.url}`);
    }
    if (job.logTail) {
      lines.push("  ```", ...job.logTail.split("\n").map((line) => `  ${line}`), "  ```");
    }
    if (job.logTruncated) {
      lines.push("  Log tail truncated to the latest capped lines.");
    }
  }
}

function formatAnnotation(annotation: CheckoutGithubCheckDetails["annotations"][number]): string {
  const location = annotation.path
    ? `${annotation.path}${formatAnnotationLines(annotation)}`
    : "unknown location";
  const level = annotation.annotationLevel ? ` ${annotation.annotationLevel}` : "";
  const message = annotation.message ? `: ${annotation.message}` : "";
  return `${location}${level}${message}`;
}

function formatAnnotationLines(
  annotation: CheckoutGithubCheckDetails["annotations"][number],
): string {
  if (annotation.startLine !== undefined && annotation.endLine !== undefined) {
    return `:${annotation.startLine}-${annotation.endLine}`;
  }
  if (annotation.startLine !== undefined) {
    return `:${annotation.startLine}`;
  }
  return "";
}

function formatActivityContextText({
  heading,
  pullRequest,
  activity,
  reviewState,
}: PullRequestContextBuilderInput & { heading: string; reviewState?: ReviewState }): string {
  const lines = [
    heading,
    `Pull request: #${pullRequest.number} ${pullRequest.title}`,
    `Pull request URL: ${pullRequest.url}`,
    `URL: ${activity.url}`,
    `Author: ${activity.author}`,
  ];

  if (reviewState) {
    lines.push(`State: ${reviewState}`);
  }
  if (activity.age) {
    lines.push(`Created: ${activity.age}`);
  }
  if (activity.location) {
    lines.push(`Location: ${formatPullRequestActivityLocation(activity)}`);
  }

  const body = activity.body.trim();
  if (body.length === 0) {
    return lines.join("\n");
  }

  return [...lines, "", body].join("\n");
}

function formatPullRequestSubtitle(pullRequest: PullRequestContextMetadata): string {
  return `#${pullRequest.number} ${pullRequest.title}`;
}
