import type { CheckoutCheckDetails } from "@getpaseo/protocol/messages";
import type { PullRequestContextAttachment } from "@/attachments/types";
import { type Forge, getForgePresentation } from "@/git/forge";
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
  forge: Forge;
  pullRequest: PullRequestContextMetadata;
  activity: PrPaneActivity;
}

export interface PullRequestThreadContextBuilderInput {
  provider: PullRequestProviderMetadata;
  forge: Forge;
  pullRequest: PullRequestContextMetadata;
  thread: PrThreadEntry;
}

export interface PullRequestGithubCheckContextBuilderInput {
  provider: PullRequestProviderMetadata;
  forge: Forge;
  pullRequest: PullRequestContextMetadata;
  check: PrPaneCheck;
  githubDetails?: CheckoutCheckDetails | null;
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
  const presentation = getForgePresentation(input.forge);
  return {
    kind: "forge.change_request_comment",
    id: `${input.pullRequest.number}:${input.activity.id}`,
    title: input.activity.author,
    subtitle: formatPullRequestSubtitle(input.pullRequest, input.forge),
    text: formatActivityContextText({
      ...input,
      heading: `${presentation.brandLabel} ${presentation.changeRequestNoun} comment`,
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

  const presentation = getForgePresentation(input.forge);
  return {
    kind: "forge.change_request_review",
    id: `${input.pullRequest.number}:${input.activity.id}`,
    title: input.activity.author,
    subtitle: formatPullRequestSubtitle(input.pullRequest, input.forge),
    text: formatActivityContextText({
      ...input,
      heading: `${presentation.brandLabel} ${presentation.changeRequestNoun} review`,
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

  const presentation = getForgePresentation(input.forge);
  const noun = capitalizeFirst(presentation.changeRequestNoun);
  const location = input.thread.location;
  const threadTitle = location ? formatPullRequestThreadPath(location) : "Discussion thread";
  const lines = [
    `${presentation.brandLabel} ${presentation.changeRequestNoun} review thread`,
    `${noun}: ${presentation.numberPrefix}${input.pullRequest.number} ${input.pullRequest.title}`,
    `${noun} URL: ${input.pullRequest.url}`,
    `URL: ${root.url}`,
  ];
  if (location) {
    lines.push(`Location: ${formatPullRequestThreadPath(location)}`);
  }
  if (location?.isResolved !== undefined) {
    lines.push(`Thread state: ${location.isResolved ? "resolved" : "unresolved"}`);
  }
  if (location?.isOutdated) {
    lines.push("Note: this thread is outdated (the code it refers to has changed)");
  }

  const conversation = comments.map(
    (comment) => `${comment.author} (${comment.age}):\n${comment.body.trim()}`,
  );

  return {
    kind: "forge.change_request_comment",
    id: `${input.pullRequest.number}:${input.thread.id}`,
    title: threadTitle,
    subtitle: formatPullRequestSubtitle(input.pullRequest, input.forge),
    text: [...lines, "", conversation.join("\n\n---\n\n")].join("\n"),
    url: root.url,
  };
}

export function buildPullRequestCheckContextAttachment(
  input: PullRequestGithubCheckContextBuilderInput,
): PullRequestContextAttachment {
  return {
    kind: "forge.change_request_check",
    id: formatPullRequestCheckContextId(input.pullRequest, input.check),
    title: input.check.name,
    subtitle: formatPullRequestSubtitle(input.pullRequest, input.forge),
    text: formatCheckContextText(input),
    url: input.githubDetails?.detailsUrl ?? input.githubDetails?.url ?? input.check.url,
  };
}

function formatPullRequestCheckContextId(
  pullRequest: PullRequestContextMetadata,
  check: PrPaneCheck,
): string {
  if (check.detailRef?.checkRunId !== undefined) {
    return `${pullRequest.number}:check-run:${check.detailRef.checkRunId}`;
  }
  return `${pullRequest.number}:check:${check.name}`;
}

function formatCheckContextText({
  provider,
  forge,
  pullRequest,
  check,
  githubDetails,
}: PullRequestGithubCheckContextBuilderInput): string {
  const presentation = getForgePresentation(forge);
  const noun = capitalizeFirst(presentation.changeRequestNoun);
  const lines = [
    `${provider.label} ${presentation.changeRequestNoun} check`,
    `${noun}: ${presentation.numberPrefix}${pullRequest.number} ${pullRequest.title}`,
    `${noun} URL: ${pullRequest.url}`,
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
    lines.push("", `Note: Check details were truncated by ${provider.label}/API or local caps.`);
  }

  return lines.join("\n");
}

function appendGitHubCheckOutput(
  lines: string[],
  details: CheckoutCheckDetails | null | undefined,
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
  details: CheckoutCheckDetails | null | undefined,
) {
  if (!details?.annotations?.length) {
    return;
  }
  lines.push("", "Annotations:");
  for (const annotation of details.annotations) {
    lines.push(`- ${formatAnnotation(annotation)}`);
  }
}

function appendGitHubFailedJobs(lines: string[], details: CheckoutCheckDetails | null | undefined) {
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

function formatAnnotation(annotation: CheckoutCheckDetails["annotations"][number]): string {
  const location = annotation.path
    ? `${annotation.path}${formatAnnotationLines(annotation)}`
    : "unknown location";
  const level = annotation.annotationLevel ? ` ${annotation.annotationLevel}` : "";
  const message = annotation.message ? `: ${annotation.message}` : "";
  return `${location}${level}${message}`;
}

function formatAnnotationLines(annotation: CheckoutCheckDetails["annotations"][number]): string {
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
  forge,
  pullRequest,
  activity,
  reviewState,
}: PullRequestContextBuilderInput & { heading: string; reviewState?: ReviewState }): string {
  const presentation = getForgePresentation(forge);
  const noun = capitalizeFirst(presentation.changeRequestNoun);
  const lines = [
    heading,
    `${noun}: ${presentation.numberPrefix}${pullRequest.number} ${pullRequest.title}`,
    `${noun} URL: ${pullRequest.url}`,
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

function formatPullRequestSubtitle(pullRequest: PullRequestContextMetadata, forge: Forge): string {
  return `${getForgePresentation(forge).numberPrefix}${pullRequest.number} ${pullRequest.title}`;
}

function capitalizeFirst(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}
