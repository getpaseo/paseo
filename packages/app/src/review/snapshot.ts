import { useMemo } from "react";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useCheckoutDiffQuery } from "@/hooks/use-checkout-diff-query";
import { useCheckoutStatusQuery } from "@/hooks/use-checkout-status-query";
import {
  buildReviewAttachmentSnapshot,
  buildReviewDraftKey,
  buildReviewDraftScopeKey,
  useActiveReviewDraftMode,
  useReviewCommentCount,
  useReviewDraftCommentsForAttachment,
  type ReviewDraftMode,
} from "./store";

export interface UseReviewWorkspaceAttachmentSnapshotInput {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
}

export interface UseReviewWorkspaceAttachmentSnapshotResult {
  attachment: WorkspaceComposerAttachment | null;
  isGit: boolean;
}

export function useReviewWorkspaceAttachmentSnapshot({
  serverId,
  workspaceId,
  cwd,
}: UseReviewWorkspaceAttachmentSnapshotInput): UseReviewWorkspaceAttachmentSnapshotResult {
  const { preferences: changesPreferences } = useChangesPreferences();
  const { status } = useCheckoutStatusQuery({ serverId, cwd });
  const gitStatus = status && status.isGit ? status : null;
  const fallbackMode: ReviewDraftMode = gitStatus?.isDirty ? "uncommitted" : "base";
  const baseRef = gitStatus?.baseRef ?? undefined;
  const reviewDraftScopeKey = buildReviewDraftScopeKey({
    serverId,
    workspaceId,
    cwd,
    baseRef,
    ignoreWhitespace: changesPreferences.hideWhitespace,
  });
  const activeMode = useActiveReviewDraftMode({ scopeKey: reviewDraftScopeKey });
  const mode = activeMode ?? fallbackMode;
  const reviewDraftKey = buildReviewDraftKey({
    serverId,
    workspaceId,
    cwd,
    mode,
    baseRef,
    ignoreWhitespace: changesPreferences.hideWhitespace,
  });
  const commentCount = useReviewCommentCount(reviewDraftKey);
  const hasComments = commentCount > 0;
  const comments = useReviewDraftCommentsForAttachment({
    key: reviewDraftKey,
    enabled: hasComments,
  });
  const { files: diffFiles } = useCheckoutDiffQuery({
    serverId,
    cwd,
    mode,
    baseRef,
    ignoreWhitespace: changesPreferences.hideWhitespace,
    enabled: Boolean(gitStatus) && hasComments,
  });

  const attachment = useMemo(() => {
    if (!gitStatus || !hasComments) {
      return null;
    }
    return buildReviewAttachmentSnapshot({
      reviewDraftKey,
      cwd,
      mode,
      baseRef,
      comments,
      diffFiles,
    });
  }, [baseRef, comments, cwd, diffFiles, gitStatus, hasComments, mode, reviewDraftKey]);

  return {
    attachment,
    isGit: Boolean(gitStatus),
  };
}
