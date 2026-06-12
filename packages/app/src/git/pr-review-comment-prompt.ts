import type { PullRequestReviewThread } from "@getpaseo/protocol/messages";

const FENCE = "```";

// Fence language hint derived from the file extension. The agent only needs a
// rough hint, so the bare extension (ts, py, go) is enough.
export function reviewCommentFenceLanguage(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return "";
  }
  return base.slice(dot + 1).toLowerCase();
}

export function formatReviewThreadLineRange(thread: PullRequestReviewThread): string | null {
  const { startLine, line } = thread;
  if (startLine !== null && line !== null && startLine !== line) {
    return `${startLine}–${line}`;
  }
  const single = line ?? startLine;
  return single === null ? null : `${single}`;
}

interface ReviewerAndBody {
  reviewer: string;
  body: string;
}

function formatThreadDiscussion(thread: PullRequestReviewThread): ReviewerAndBody {
  const comments = thread.comments;
  const reviewer = comments[0]?.author ?? "unknown";
  if (comments.length <= 1) {
    return { reviewer, body: comments[0]?.body ?? "" };
  }
  // Multiple comments: keep the whole discussion, attributing each reply so the
  // agent can follow the back-and-forth.
  const body = comments.map((comment) => `${comment.author}: ${comment.body}`).join("\n\n");
  return { reviewer, body };
}

export function buildReviewCommentBlock(thread: PullRequestReviewThread): string {
  const lineRange = formatReviewThreadLineRange(thread);
  const language = reviewCommentFenceLanguage(thread.path);
  const { reviewer, body } = formatThreadDiscussion(thread);
  return [
    "[PR review comment]",
    `File: ${thread.path}`,
    ...(lineRange ? [`Lines: ${lineRange}`] : []),
    `Reviewer: ${reviewer}`,
    "",
    `${FENCE}${language}`,
    thread.diffHunk,
    FENCE,
    "",
    body,
  ].join("\n");
}

export function buildReviewCommentsPrompt(threads: readonly PullRequestReviewThread[]): string {
  if (threads.length === 0) {
    return "";
  }
  if (threads.length === 1) {
    return buildReviewCommentBlock(threads[0]);
  }
  const preamble = `Address the following ${threads.length} PR review comments:`;
  return [preamble, ...threads.map(buildReviewCommentBlock)].join("\n\n");
}
