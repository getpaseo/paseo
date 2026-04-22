import {
  GitHubIssueAttachmentSchema,
  GitHubPrAttachmentSchema,
  ReviewAttachmentSchema,
  type AgentAttachment,
} from "../../shared/messages.js";

type GitHubPrPromptAttachment = Extract<AgentAttachment, { type: "github_pr" }>;
type GitHubIssuePromptAttachment = Extract<AgentAttachment, { type: "github_issue" }>;
type ReviewPromptAttachment = Extract<AgentAttachment, { type: "review" }>;
type ReviewPromptComment = ReviewPromptAttachment["comments"][number];
type ReviewPromptContextLine = ReviewPromptComment["context"]["lines"][number];
type ReviewPromptContextTargetLine = ReviewPromptComment["context"]["targetLine"];

export function renderPromptAttachmentAsText(block: unknown): string | null {
  const attachment = parseRenderablePromptAttachment(block);
  if (!attachment) {
    return null;
  }

  switch (attachment.type) {
    case "github_pr":
      return renderGitHubPrAttachmentAsText(attachment);
    case "github_issue":
      return renderGitHubIssueAttachmentAsText(attachment);
    case "review":
      return renderReviewAttachmentAsText(attachment);
  }
}

function parseRenderablePromptAttachment(
  block: unknown,
): GitHubPrPromptAttachment | GitHubIssuePromptAttachment | ReviewPromptAttachment | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const record = block as { type?: unknown };
  switch (record.type) {
    case "github_pr": {
      const parsed = GitHubPrAttachmentSchema.safeParse(block);
      return parsed.success ? parsed.data : null;
    }
    case "github_issue": {
      const parsed = GitHubIssueAttachmentSchema.safeParse(block);
      return parsed.success ? parsed.data : null;
    }
    case "review": {
      const parsed = ReviewAttachmentSchema.safeParse(block);
      return parsed.success ? parsed.data : null;
    }
    default:
      return null;
  }
}

function renderGitHubPrAttachmentAsText(attachment: GitHubPrPromptAttachment): string {
  const lines = [`GitHub PR #${attachment.number}: ${attachment.title}`, attachment.url];
  if (attachment.baseRefName) {
    lines.push(`Base: ${attachment.baseRefName}`);
  }
  if (attachment.headRefName) {
    lines.push(`Head: ${attachment.headRefName}`);
  }
  if (attachment.body) {
    lines.push("", attachment.body);
  }
  return lines.join("\n");
}

function renderGitHubIssueAttachmentAsText(attachment: GitHubIssuePromptAttachment): string {
  const lines = [`GitHub Issue #${attachment.number}: ${attachment.title}`, attachment.url];
  if (attachment.body) {
    lines.push("", attachment.body);
  }
  return lines.join("\n");
}

function renderReviewAttachmentAsText(attachment: ReviewPromptAttachment): string {
  const lines = [`Paseo review attachment (${attachment.mode})`, `CWD: ${attachment.cwd}`];
  if (attachment.baseRef) {
    lines.push(`Base: ${attachment.baseRef}`);
  }

  attachment.comments.forEach((comment, index) => {
    lines.push(
      "",
      `Comment ${index + 1}: ${comment.filePath}:${comment.side}:${comment.lineNumber}`,
      comment.body,
      comment.context.hunkHeader,
    );
    for (const contextLine of comment.context.lines) {
      lines.push(
        formatReviewContextLine({ line: contextLine, targetLine: comment.context.targetLine }),
      );
    }
  });

  return lines.join("\n");
}

function formatReviewContextLine(params: {
  line: ReviewPromptContextLine;
  targetLine: ReviewPromptContextTargetLine;
}): string {
  const { line, targetLine } = params;
  const prefix = isSameReviewContextLine(line, targetLine) ? "> " : "  ";
  const oldLineNumber = formatReviewLineNumber(line.oldLineNumber);
  const newLineNumber = formatReviewLineNumber(line.newLineNumber);
  const marker = getReviewContextLineMarker(line.type);
  return `${prefix}${oldLineNumber} ${newLineNumber} ${marker}${line.content}`;
}

function isSameReviewContextLine(
  line: ReviewPromptContextLine,
  targetLine: ReviewPromptContextTargetLine,
): boolean {
  return (
    line.oldLineNumber === targetLine.oldLineNumber &&
    line.newLineNumber === targetLine.newLineNumber &&
    line.type === targetLine.type &&
    line.content === targetLine.content
  );
}

function formatReviewLineNumber(lineNumber: number | null): string {
  return (lineNumber?.toString() ?? "-").padStart(2);
}

function getReviewContextLineMarker(lineType: ReviewPromptContextLine["type"]): string {
  switch (lineType) {
    case "add":
      return "+";
    case "remove":
      return "-";
    case "context":
      return " ";
  }
}

export function findGitHubPrAttachment(
  attachments: readonly AgentAttachment[] | undefined,
): Extract<AgentAttachment, { type: "github_pr" }> | null {
  if (!attachments) {
    return null;
  }
  return (
    attachments.find(
      (attachment): attachment is Extract<AgentAttachment, { type: "github_pr" }> =>
        attachment.type === "github_pr",
    ) ?? null
  );
}
