import { useEffect, useMemo } from "react";
import { View, Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useCommitFileDiff } from "@/git/use-commit-file-diff";
import { DiffFileBody } from "@/git/diff-file-body";
import { useAppSettings } from "@/hooks/use-settings";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import {
  buildReviewDraftKey,
  useInlineReviewController,
  useReviewAttachmentSnapshot,
} from "@/review";
import {
  useWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

interface CommitFileDiffViewProps {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  sha: string;
  path: string;
}

// Renders the per-commit file diff through the same DiffFileBody the Changes
// panel uses, so the two stay pixel-identical across unified/split and
// wrap/no-wrap. Layout and wrap come from the shared Changes preferences, mirroring
// GitDiffPane: split is only available on non-compact web; otherwise unified.
//
// Inline review is wired with the same infra as GitDiffPane, but namespaced by
// the reviewed commit SHA (mode "base", commitSha) so a commit's comments never
// collide with the Changes-panel uncommitted/base drafts for the same cwd. The
// attachment registers under a per-commit source (reviewDraftKey) so it coexists
// with — instead of clobbering — the Changes-panel review in the composer.
function CommitFileDiffBody({
  file,
  serverId,
  workspaceId,
  cwd,
  sha,
}: {
  file: ParsedDiffFile;
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  sha: string;
}) {
  const { settings } = useAppSettings();
  const { preferences } = useChangesPreferences();
  const isCompact = useIsCompactFormFactor();
  const wrapLines = preferences.wrapLines;
  const layout = isWeb && !isCompact ? preferences.layout : "unified";

  const reviewDraftKey = useMemo(
    () =>
      buildReviewDraftKey({
        serverId,
        workspaceId,
        cwd,
        mode: "base",
        baseRef: null,
        ignoreWhitespace: preferences.hideWhitespace,
        commitSha: sha,
      }),
    [serverId, workspaceId, cwd, sha, preferences.hideWhitespace],
  );

  const reviewActions = useInlineReviewController({ reviewDraftKey });
  const diffFiles = useMemo(() => [file], [file]);
  const reviewAttachment = useReviewAttachmentSnapshot({
    key: reviewDraftKey,
    diffFiles,
    cwd,
    mode: "base",
    baseRef: null,
    commitSha: sha,
  });

  const workspaceAttachmentScopeKey = useWorkspaceAttachmentScopeKey({
    serverId,
    workspaceId,
    cwd,
  });
  const setWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.setWorkspaceAttachments,
  );
  const clearWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.clearWorkspaceAttachments,
  );

  useEffect(() => {
    setWorkspaceAttachments({
      scopeKey: workspaceAttachmentScopeKey,
      sourceKey: reviewDraftKey,
      attachments: reviewAttachment ? [reviewAttachment] : [],
    });

    return () => {
      // Clears only this commit's source slice, leaving the Changes-panel
      // (default-source) review and any other per-commit reviews intact.
      clearWorkspaceAttachments({
        scopeKey: workspaceAttachmentScopeKey,
        sourceKey: reviewDraftKey,
      });
    };
  }, [
    setWorkspaceAttachments,
    clearWorkspaceAttachments,
    workspaceAttachmentScopeKey,
    reviewAttachment,
    reviewDraftKey,
  ]);

  return (
    <DiffFileBody
      file={file}
      layout={layout}
      wrapLines={wrapLines}
      codeFontSize={settings.codeFontSize}
      reviewActions={reviewActions}
    />
  );
}

function CommitFileDiffContent({
  file,
  isLoading,
  error,
  serverId,
  workspaceId,
  cwd,
  sha,
}: {
  file: ParsedDiffFile | null;
  isLoading: boolean;
  error: Error | null;
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  sha: string;
}) {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <View style={styles.statusRow}>
        <ThemedLoadingSpinner uniProps={spinnerColorMapping} />
      </View>
    );
  }
  if (error) {
    return <Text style={styles.error}>{t("workspace.git.diff.commits.fileDiffError")}</Text>;
  }
  if (file) {
    return (
      <CommitFileDiffBody
        file={file}
        serverId={serverId}
        workspaceId={workspaceId}
        cwd={cwd}
        sha={sha}
      />
    );
  }
  return <Text style={styles.message}>{t("workspace.git.diff.commits.fileDiffEmpty")}</Text>;
}

export function CommitFileDiffView({
  serverId,
  workspaceId,
  cwd,
  sha,
  path,
}: CommitFileDiffViewProps) {
  const { file, isLoading, error } = useCommitFileDiff({ serverId, cwd, sha, path });

  return (
    <View testID={`commit-file-diff-${path}`}>
      <CommitFileDiffContent
        file={file}
        isLoading={isLoading}
        error={error}
        serverId={serverId}
        workspaceId={workspaceId}
        cwd={cwd}
        sha={sha}
      />
    </View>
  );
}

const spinnerColorMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

const styles = StyleSheet.create((theme) => ({
  statusRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    alignItems: "flex-start",
  },
  message: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  error: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
}));
