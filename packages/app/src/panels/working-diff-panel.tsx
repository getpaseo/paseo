import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FileDiff } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useIsCompactFormFactor, WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import {
  DiffFilesToolbar,
  DiffLayoutToggle,
  DiffOptionsMenu,
  SharedDiffView,
} from "@/git/diff-pane";
import { useCheckoutDiffQuery } from "@/git/use-diff-query";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useAppSettings } from "@/hooks/use-settings";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import {
  buildReviewDraftKey,
  useInlineReviewController,
  useReviewAttachmentSnapshot,
} from "@/review";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";

const ThemedFileDiff = withUnistyles(FileDiff);

function WorkingDiffPanel() {
  const { t } = useTranslation();
  const toast = useToast();
  const { serverId, workspaceId, tabId, target, openTab } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isActive = useRetainedPanelActive();
  const { settings } = useAppSettings();
  const { preferences, updatePreferences } = useChangesPreferences();
  const isCompact = useIsCompactFormFactor();
  const [expandedPaths, setExpandedPaths] = useState<string[] | null>(null);
  const refreshSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.checkoutRefresh === true,
  );
  const runRefresh = useCheckoutGitActionsStore((state) => state.refresh);
  const isRefreshing =
    useCheckoutGitActionsStore((state) =>
      state.getStatus({ serverId, cwd: cwd ?? "", actionId: "refresh" }),
    ) === "pending";
  invariant(target.kind === "working_diff", "WorkingDiffPanel requires working_diff target");

  const { files, payloadError, isLoading } = useCheckoutDiffQuery({
    serverId,
    cwd: cwd ?? "",
    mode: target.mode,
    baseRef: target.baseRef ?? undefined,
    ignoreWhitespace: target.ignoreWhitespace,
    enabled: Boolean(cwd) && isActive,
    queryScope: `working-diff-tab:${tabId}`,
  });
  const reviewDraftKey = useMemo(
    () =>
      buildReviewDraftKey({
        serverId,
        workspaceId,
        cwd: cwd ?? "",
        mode: target.mode,
        baseRef: target.baseRef,
        ignoreWhitespace: target.ignoreWhitespace,
      }),
    [cwd, serverId, target.baseRef, target.ignoreWhitespace, target.mode, workspaceId],
  );
  const reviewActions = useInlineReviewController({ reviewDraftKey });
  const reviewAttachment = useReviewAttachmentSnapshot({
    key: reviewDraftKey,
    diffFiles: files,
    cwd: cwd ?? "",
    mode: target.mode,
    baseRef: target.baseRef,
  });
  const workspaceAttachmentScopeKey = useMemo(
    () => buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd: cwd ?? "" }),
    [cwd, serverId, workspaceId],
  );
  const setWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.setWorkspaceAttachments,
  );
  const clearWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.clearWorkspaceAttachments,
  );
  useEffect(() => {
    if (!isActive) {
      return;
    }
    const attachments = reviewAttachment ? [reviewAttachment] : [];
    setWorkspaceAttachments({ scopeKey: workspaceAttachmentScopeKey, attachments });
    return () => {
      const currentAttachments =
        useWorkspaceAttachmentsStore.getState().attachmentsByScope[workspaceAttachmentScopeKey];
      if (currentAttachments === attachments) {
        clearWorkspaceAttachments({ scopeKey: workspaceAttachmentScopeKey });
      }
    };
  }, [
    clearWorkspaceAttachments,
    isActive,
    reviewAttachment,
    setWorkspaceAttachments,
    workspaceAttachmentScopeKey,
  ]);
  const canUseSplitLayout = isWeb && !isCompact;
  const effectiveLayout = canUseSplitLayout ? preferences.layout : "unified";
  const handleToggleLayout = useCallback(() => {
    void updatePreferences({ layout: preferences.layout === "unified" ? "split" : "unified" });
  }, [preferences.layout, updatePreferences]);
  const handleToggleWrapLines = useCallback(() => {
    void updatePreferences({ wrapLines: !preferences.wrapLines });
  }, [preferences.wrapLines, updatePreferences]);
  const handleToggleHideWhitespace = useCallback(() => {
    openTab({
      ...target,
      ignoreWhitespace: !target.ignoreWhitespace,
    });
  }, [openTab, target]);
  const handleRefresh = useCallback(() => {
    if (!cwd || isRefreshing) {
      return;
    }
    void runRefresh({ serverId, cwd }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("workspace.git.diff.failedRefresh"));
    });
  }, [cwd, isRefreshing, runRefresh, serverId, t, toast]);
  const displayPreferences = useMemo(
    () => ({
      layout: effectiveLayout,
      wrapLines: preferences.wrapLines,
      codeFontSize: settings.codeFontSize,
      monoFontFamily: settings.monoFontFamily,
    }),
    [effectiveLayout, preferences.wrapLines, settings.codeFontSize, settings.monoFontFamily],
  );
  const handleExpandedPathsChange = useCallback((paths: string[]) => {
    setExpandedPaths(paths);
  }, []);
  const expandedPathSet = useMemo(
    () => (expandedPaths === null ? null : new Set(expandedPaths)),
    [expandedPaths],
  );
  const allFilesExpanded =
    files.length > 0 &&
    (expandedPathSet === null || files.every((file) => expandedPathSet.has(file.path)));
  const handleToggleExpandAll = useCallback(() => {
    setExpandedPaths(allFilesExpanded ? [] : null);
  }, [allFilesExpanded]);
  const workingTabMode = useMemo(
    () => ({
      kind: "working_tab" as const,
      expandedPaths,
      reviewActions,
      focusPath: target.focusPath,
      focusRequestId: target.focusRequestId,
      onExpandedPathsChange: handleExpandedPathsChange,
    }),
    [
      expandedPaths,
      handleExpandedPathsChange,
      reviewActions,
      target.focusPath,
      target.focusRequestId,
    ],
  );

  let bodyContent: ReactNode;
  if (!cwd) {
    bodyContent = <PanelState message={t("panels.diff.directoryMissing")} />;
  } else if (!isConnected) {
    bodyContent = <PanelState message={t("workspace.terminal.hostDisconnected")} />;
  } else if (payloadError) {
    bodyContent = (
      <PanelState message={t("panels.diff.loadError")} tone="error" testID="working-diff-error" />
    );
  } else if (isLoading) {
    bodyContent = (
      <PanelState message={t("workspace.tabs.loading")} testID="working-diff-loading" />
    );
  } else if (files.length === 0) {
    bodyContent = (
      <PanelState
        message={
          target.ignoreWhitespace
            ? t("workspace.git.diff.emptyHiddenWhitespace")
            : t("panels.diff.empty")
        }
        testID="working-diff-empty"
      />
    );
  } else {
    bodyContent = (
      <SharedDiffView files={files} displayPreferences={displayPreferences} mode={workingTabMode} />
    );
  }

  return (
    <View style={styles.container} testID="working-diff-panel">
      <View style={styles.toolbar} testID="working-diff-toolbar">
        {canUseSplitLayout ? (
          <DiffLayoutToggle
            layout={preferences.layout}
            isMobile={isCompact}
            testID="working-diff-toggle-layout"
            onToggle={handleToggleLayout}
          />
        ) : null}
        {files.length > 0 ? (
          <DiffFilesToolbar
            allFileDiffsExpanded={allFilesExpanded}
            isMobile={isCompact}
            testID="working-diff-toggle-expand-all"
            onToggleExpandAll={handleToggleExpandAll}
          />
        ) : null}
        <DiffOptionsMenu
          hideWhitespace={target.ignoreWhitespace}
          isMobile={isCompact}
          isRefreshing={isRefreshing}
          refreshSupported={refreshSupported}
          testIDPrefix="working-diff"
          wrapLines={preferences.wrapLines}
          onRefresh={handleRefresh}
          onToggleHideWhitespace={handleToggleHideWhitespace}
          onToggleWrapLines={handleToggleWrapLines}
        />
      </View>
      <View style={styles.body}>{bodyContent}</View>
    </View>
  );
}

function PanelState({
  message,
  tone = "muted",
  testID,
}: {
  message: string;
  tone?: "muted" | "error";
  testID?: string;
}) {
  return (
    <View style={styles.centerState} testID={testID}>
      <Text style={tone === "error" ? styles.errorText : styles.mutedText}>{message}</Text>
    </View>
  );
}

function useWorkingDiffPanelDescriptor(
  target: Extract<WorkspaceTabTarget, { kind: "working_diff" }>,
): PanelDescriptor {
  const { t } = useTranslation();
  const comparison =
    target.mode === "uncommitted"
      ? t("panels.diff.uncommittedSubtitle")
      : t("panels.diff.baseSubtitle", { baseRef: target.baseRef });
  return {
    label: t("panels.diff.changesLabel"),
    subtitle: comparison,
    tooltip: comparison,
    titleState: "ready",
    icon: ThemedFileDiff,
    statusBucket: null,
  };
}

export const workingDiffPanelRegistration: PanelRegistration<"working_diff"> = {
  kind: "working_diff",
  component: WorkingDiffPanel,
  useDescriptor: useWorkingDiffPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  toolbar: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    flexShrink: 0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[16],
  },
  mutedText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    textAlign: "center",
  },
}));
