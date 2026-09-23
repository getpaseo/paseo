import type { ReviewableDiffTarget } from "@/utils/diff-layout";
import { buildReviewableDiffTargetKey } from "@/utils/diff-layout";
import type { ReviewDraftComment } from "./store";
import type { GithubReviewSession } from "./github-session";
import type { GithubDiffThread, GithubReviewOverlay } from "./github-threads";

export const INLINE_REVIEW_COMMENT_HEIGHT = 72;
export const INLINE_REVIEW_GITHUB_COMMENT_HEIGHT = 88;
export const INLINE_REVIEW_EDITOR_HEIGHT = 132;
export const INLINE_REVIEW_GAP = 6;
export const INLINE_REVIEW_VERTICAL_PADDING = 8;

export interface InlineReviewEditorState {
  target: ReviewableDiffTarget;
  commentId: string | null;
  replyThreadId: string | null;
  body: string;
}

export interface InlineReviewActions {
  commentsByTarget: ReadonlyMap<string, ReviewDraftComment[]>;
  githubThreadsByTarget: ReadonlyMap<string, GithubDiffThread[]>;
  unmatchedOutdatedByPath: ReadonlyMap<string, number>;
  editor: InlineReviewEditorState | null;
  githubWrite: GithubReviewSession | null;
  onStartComment: (target: ReviewableDiffTarget) => void;
  onEditComment: (target: ReviewableDiffTarget, comment: ReviewDraftComment) => void;
  onReply: (target: ReviewableDiffTarget, threadId: string) => void;
  onCancelEditor: () => void;
  onSaveEditor: (body: string) => void;
  onPublishComment: (body: string) => void;
  onStartReview: (body: string) => void;
  onDeleteComment: (id: string) => void;
}

export function stubInlineReviewActions(
  overrides: Partial<InlineReviewActions> = {},
): InlineReviewActions {
  return {
    commentsByTarget: new Map(),
    githubThreadsByTarget: new Map(),
    unmatchedOutdatedByPath: new Map(),
    editor: null,
    githubWrite: null,
    onStartComment() {},
    onEditComment() {},
    onReply() {},
    onCancelEditor() {},
    onSaveEditor() {},
    onPublishComment() {},
    onStartReview() {},
    onDeleteComment() {},
    ...overrides,
  };
}

export function emptyGithubOverlay(): GithubReviewOverlay {
  return { threadsByTarget: new Map(), unmatchedOutdatedByPath: new Map() };
}

export function isInlineReviewEditorForTarget(
  editor: InlineReviewEditorState | null,
  target: ReviewableDiffTarget | null | undefined,
): boolean {
  return Boolean(
    editor &&
    target &&
    buildReviewableDiffTargetKey(editor.target) === buildReviewableDiffTargetKey(target),
  );
}

export function hasInlineReviewOverlay(
  reviewActions: InlineReviewActions,
  target: ReviewableDiffTarget,
): boolean {
  if ((reviewActions.commentsByTarget.get(target.key)?.length ?? 0) > 0) return true;
  if ((reviewActions.githubThreadsByTarget.get(target.key)?.length ?? 0) > 0) return true;
  return isInlineReviewEditorForTarget(reviewActions.editor, target);
}

export function getInlineReviewThreadState(input: {
  reviewTarget: ReviewableDiffTarget | null | undefined;
  reviewActions?: InlineReviewActions;
}): {
  comments: ReviewDraftComment[];
  hasEditor: boolean;
  editingCommentId: string | null;
  height: number;
} | null {
  const { reviewTarget, reviewActions } = input;
  if (!reviewTarget || !reviewActions) return null;

  const comments = reviewActions.commentsByTarget.get(reviewTarget.key) ?? [];
  const githubThreads = reviewActions.githubThreadsByTarget.get(reviewTarget.key) ?? [];
  const githubCommentCount = githubThreads.reduce(
    (count, thread) => count + thread.comments.length,
    0,
  );
  const editorForTarget = isInlineReviewEditorForTarget(reviewActions.editor, reviewTarget)
    ? reviewActions.editor
    : null;
  const hasEditor = editorForTarget !== null;
  const editingCommentId = editorForTarget?.commentId ?? null;
  const editingExisting =
    editingCommentId !== null && comments.some((comment) => comment.id === editingCommentId);
  const visibleCommentCount = editingExisting ? comments.length - 1 : comments.length;
  const editorCount = hasEditor ? 1 : 0;
  const visibleBlockCount = visibleCommentCount + githubCommentCount + editorCount;
  if (visibleBlockCount === 0) return null;

  const height =
    visibleCommentCount * INLINE_REVIEW_COMMENT_HEIGHT +
    githubCommentCount * INLINE_REVIEW_GITHUB_COMMENT_HEIGHT +
    editorCount * INLINE_REVIEW_EDITOR_HEIGHT +
    Math.max(0, visibleBlockCount - 1) * INLINE_REVIEW_GAP +
    INLINE_REVIEW_VERTICAL_PADDING * 2;
  return { comments, hasEditor, editingCommentId, height };
}

export function getSplitInlineReviewThreadState(input: {
  left: ReviewableDiffTarget | null | undefined;
  right: ReviewableDiffTarget | null | undefined;
  reviewActions?: InlineReviewActions;
}): {
  left: ReturnType<typeof getInlineReviewThreadState>;
  right: ReturnType<typeof getInlineReviewThreadState>;
  height: number;
} | null {
  const left = getInlineReviewThreadState({
    reviewTarget: input.left,
    reviewActions: input.reviewActions,
  });
  const right = getInlineReviewThreadState({
    reviewTarget: input.right,
    reviewActions: input.reviewActions,
  });
  const height = Math.max(left?.height ?? 0, right?.height ?? 0);
  return height === 0 ? null : { left, right, height };
}
