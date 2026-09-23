import type { PullRequestTimelineItem } from "@getpaseo/protocol/messages";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import { buildNumberedDiffHunks, buildReviewableDiffTargetKey } from "@/utils/diff-layout";

export interface GithubReviewComment {
  id: string;
  threadId: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface GithubDiffThread {
  threadId: string;
  filePath: string;
  side: "old" | "new";
  lineNumber: number;
  isResolved?: boolean;
  isOutdated: boolean;
  comments: GithubReviewComment[];
}

export interface GithubReviewOverlay {
  threadsByTarget: Map<string, GithubDiffThread[]>;
  unmatchedOutdatedByPath: Map<string, number>;
}

const EMPTY_OVERLAY: GithubReviewOverlay = {
  threadsByTarget: new Map(),
  unmatchedOutdatedByPath: new Map(),
};

export function collectVisibleReviewTargetKeys(files: readonly ParsedDiffFile[]): Set<string> {
  const keys = new Set<string>();
  for (const file of files) {
    for (const hunk of buildNumberedDiffHunks(file)) {
      for (const line of hunk.lines) {
        if (line.unifiedCell) keys.add(line.unifiedCell.key);
        if (line.oldCell) keys.add(line.oldCell.key);
        if (line.newCell) keys.add(line.newCell.key);
      }
    }
  }
  return keys;
}

export function mapGithubReviewOverlay(input: {
  items: readonly PullRequestTimelineItem[];
  visibleTargetKeys: ReadonlySet<string>;
}): GithubReviewOverlay {
  const threads = new Map<string, GithubDiffThread>();
  for (const item of input.items) {
    if (item.kind !== "comment" || !item.location?.path) continue;
    const threadId = item.location.threadId ?? item.threadId ?? item.id;
    if (!threadId) continue;
    const lineNumber = item.location.line;
    if (lineNumber === undefined) continue;
    const side = item.location.side ?? "new";
    const existing = threads.get(threadId);
    const comment: GithubReviewComment = {
      id: item.id,
      threadId,
      author: item.author,
      body: item.body,
      createdAt: item.createdAt,
    };
    if (existing) {
      existing.comments.push(comment);
      continue;
    }
    threads.set(threadId, {
      threadId,
      filePath: item.location.path,
      side,
      lineNumber,
      isResolved: item.location.isResolved,
      isOutdated: item.location.isOutdated ?? false,
      comments: [comment],
    });
  }

  if (threads.size === 0) return EMPTY_OVERLAY;

  const threadsByTarget = new Map<string, GithubDiffThread[]>();
  const unmatchedOutdatedByPath = new Map<string, number>();
  for (const thread of threads.values()) {
    const key = buildReviewableDiffTargetKey({
      filePath: thread.filePath,
      side: thread.side,
      lineNumber: thread.lineNumber,
    });
    if (input.visibleTargetKeys.has(key)) {
      threadsByTarget.set(key, [...(threadsByTarget.get(key) ?? []), thread]);
      continue;
    }
    if (!thread.isOutdated) continue;
    unmatchedOutdatedByPath.set(
      thread.filePath,
      (unmatchedOutdatedByPath.get(thread.filePath) ?? 0) + 1,
    );
  }
  return { threadsByTarget, unmatchedOutdatedByPath };
}
