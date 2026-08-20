import { useCallback, useEffect, useMemo } from "react";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  buildReviewDraftKey,
  useInlineReviewController,
  useReviewAttachmentSnapshot,
} from "@/review";
import { useCheckoutDiffQuery } from "@/git/use-diff-query";
import { useCheckoutStatusQuery } from "@/git/use-status-query";

interface UseWorkingDiffOptions {
  serverId: string;
  workspaceId?: string;
  cwd: string;
  ignoreWhitespace: boolean;
  enabled: boolean;
  queryScope?: string;
  mode?: "uncommitted" | "base";
  baseRef?: string;
  onModeChange?: (mode: "uncommitted" | "base") => void;
}

export function useWorkingDiff({
  serverId,
  workspaceId,
  cwd,
  ignoreWhitespace,
  enabled,
  queryScope,
  mode,
  baseRef: selectedBaseRef,
  onModeChange,
}: UseWorkingDiffOptions) {
  const {
    status,
    isLoading: isStatusLoading,
    isError: isStatusError,
    error: statusError,
  } = useCheckoutStatusQuery({ serverId, cwd });
  const gitStatus = status && status.isGit ? status : null;
  const isGit = Boolean(gitStatus);
  const notGit = status !== null && !status.isGit && !status.error;
  const statusErrorMessage =
    status?.error?.message ??
    (isStatusError && statusError instanceof Error ? statusError.message : null);
  const baseRef = selectedBaseRef ?? gitStatus?.baseRef ?? undefined;
  const hasUncommittedChanges = Boolean(gitStatus?.isDirty);
  const currentBranchName =
    gitStatus?.currentBranch && gitStatus.currentBranch !== "HEAD" ? gitStatus.currentBranch : null;

  const selectDiffMode = useCallback(
    (nextMode: "uncommitted" | "base") => {
      if (onModeChange) {
        onModeChange(nextMode);
        return;
      }
      // A Changes surface always supplies its tab-owned presentation. Keep this
      // fallback deterministic for legacy non-tab consumers without mutating
      // workspace-wide review preferences.
    },
    [onModeChange],
  );
  const selectUncommitted = useCallback(() => selectDiffMode("uncommitted"), [selectDiffMode]);
  const selectBase = useCallback(() => selectDiffMode("base"), [selectDiffMode]);
  const diffMode = mode ?? (hasUncommittedChanges ? "uncommitted" : "base");

  const {
    files,
    payloadError: diffPayloadError,
    diffTooLarge,
    isLoading: isDiffLoading,
  } = useCheckoutDiffQuery({
    serverId,
    cwd,
    mode: diffMode,
    baseRef,
    ignoreWhitespace,
    enabled: enabled && isGit,
    queryScope,
  });
  const reviewDraftKey = useMemo(
    () =>
      buildReviewDraftKey({
        serverId,
        workspaceId,
        cwd,
        mode: diffMode,
        baseRef,
        ignoreWhitespace,
      }),
    [baseRef, cwd, diffMode, ignoreWhitespace, serverId, workspaceId],
  );
  const reviewActions = useInlineReviewController({ reviewDraftKey });
  const reviewAttachment = useReviewAttachmentSnapshot({
    key: reviewDraftKey,
    diffFiles: files,
    cwd,
    mode: diffMode,
    baseRef,
  });

  return {
    status,
    isStatusLoading,
    isGit,
    notGit,
    statusErrorMessage,
    baseRef,
    currentBranchName,
    diffMode,
    selectUncommitted,
    selectBase,
    files,
    diffPayloadError,
    diffTooLarge,
    isDiffLoading,
    reviewActions,
    reviewAttachment,
  };
}

export function usePublishWorkingDiffAttachment({
  serverId,
  workspaceId,
  cwd,
  attachment,
  enabled,
}: {
  serverId: string;
  workspaceId?: string;
  cwd: string;
  attachment: ReturnType<typeof useWorkingDiff>["reviewAttachment"];
  enabled: boolean;
}) {
  const scopeKey = useMemo(
    () => buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd }),
    [cwd, serverId, workspaceId],
  );
  const setWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.setWorkspaceAttachments,
  );
  const clearWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.clearWorkspaceAttachments,
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const attachments = attachment ? [attachment] : [];
    setWorkspaceAttachments({ scopeKey, attachments });
    return () => {
      const current = useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey];
      if (current === attachments) {
        clearWorkspaceAttachments({ scopeKey });
      }
    };
  }, [attachment, clearWorkspaceAttachments, enabled, scopeKey, setWorkspaceAttachments]);
}
