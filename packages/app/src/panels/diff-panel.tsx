import { useCallback, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FileDiff, GitCommitHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useIsCompactFormFactor, WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import {
  DiffFilesToolbar,
  DiffLayoutToggle,
  DiffModeMenu,
  DiffOptionsMenu,
  resolveDiffLayout,
  SharedDiffView,
} from "@/git/diff-pane";
import { useCommitDiffFiles } from "@/git/use-diff-files";
import { usePublishWorkingDiffAttachment, useWorkingDiff } from "@/git/use-working-diff";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useAppSettings } from "@/hooks/use-settings";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

const ThemedFileDiff = withUnistyles(FileDiff);
const ThemedGitCommitHorizontal = withUnistyles(GitCommitHorizontal);

function useDiffPanelPreferences() {
  const { settings } = useAppSettings();
  const { preferences, updatePreferences } = useChangesPreferences();
  const isCompact = useIsCompactFormFactor();
  const canUseSplitLayout = isWeb && !isCompact;
  const effectiveLayout = resolveDiffLayout(preferences.layout, canUseSplitLayout);
  const displayPreferences = useMemo(
    () => ({
      layout: effectiveLayout,
      wrapLines: preferences.wrapLines,
      codeFontSize: settings.codeFontSize,
      monoFontFamily: settings.monoFontFamily,
    }),
    [effectiveLayout, preferences.wrapLines, settings.codeFontSize, settings.monoFontFamily],
  );
  const toggleLayout = useCallback(() => {
    void updatePreferences({ layout: preferences.layout === "unified" ? "split" : "unified" });
  }, [preferences.layout, updatePreferences]);
  const toggleWrapLines = useCallback(() => {
    void updatePreferences({ wrapLines: !preferences.wrapLines });
  }, [preferences.wrapLines, updatePreferences]);
  const toggleHideWhitespace = useCallback(() => {
    void updatePreferences({ hideWhitespace: !preferences.hideWhitespace });
  }, [preferences.hideWhitespace, updatePreferences]);

  return {
    preferences,
    isCompact,
    canUseSplitLayout,
    displayPreferences,
    toggleLayout,
    toggleWrapLines,
    toggleHideWhitespace,
  };
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

function WorkingDiffBody({
  cwd,
  isConnected,
  workingDiff,
  hideWhitespace,
  displayPreferences,
  mode,
}: {
  cwd: string | null | undefined;
  isConnected: boolean;
  workingDiff: ReturnType<typeof useWorkingDiff>;
  hideWhitespace: boolean;
  displayPreferences: ReturnType<typeof useDiffPanelPreferences>["displayPreferences"];
  mode: Extract<ComponentProps<typeof SharedDiffView>["mode"], { kind: "working_tab" }>;
}) {
  const { t } = useTranslation();
  if (!cwd) {
    return <PanelState message={t("panels.diff.directoryMissing")} />;
  }
  if (!isConnected) {
    return <PanelState message={t("workspace.terminal.hostDisconnected")} />;
  }
  if (workingDiff.isStatusLoading) {
    return <PanelState message={t("workspace.git.diff.checkingRepository")} />;
  }
  if (workingDiff.statusErrorMessage) {
    return (
      <PanelState
        message={workingDiff.statusErrorMessage}
        tone="error"
        testID="working-diff-error"
      />
    );
  }
  if (workingDiff.notGit) {
    return <PanelState message={t("workspace.git.diff.notRepository")} />;
  }
  if (workingDiff.diffPayloadError) {
    return (
      <PanelState message={t("panels.diff.loadError")} tone="error" testID="working-diff-error" />
    );
  }
  if (workingDiff.isDiffLoading && workingDiff.files.length === 0) {
    return <PanelState message={t("workspace.tabs.loading")} testID="working-diff-loading" />;
  }
  if (workingDiff.files.length === 0) {
    return (
      <PanelState
        message={
          hideWhitespace ? t("workspace.git.diff.emptyHiddenWhitespace") : t("panels.diff.empty")
        }
        testID="working-diff-empty"
      />
    );
  }
  return (
    <SharedDiffView files={workingDiff.files} displayPreferences={displayPreferences} mode={mode} />
  );
}

function WorkingDiffPanel() {
  const { t } = useTranslation();
  const toast = useToast();
  const { serverId, workspaceId, tabId, target } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isActive = useRetainedPanelActive();
  const panelPreferences = useDiffPanelPreferences();
  const [expandedPaths, setExpandedPaths] = useState<string[] | null>(null);
  invariant(target.kind === "working_diff", "WorkingDiffPanel requires working_diff target");

  const workingDiff = useWorkingDiff({
    serverId,
    workspaceId,
    cwd: cwd ?? "",
    ignoreWhitespace: panelPreferences.preferences.hideWhitespace,
    enabled: Boolean(cwd) && isActive,
    queryScope: `working-diff-tab:${tabId}`,
  });
  usePublishWorkingDiffAttachment({
    serverId,
    workspaceId,
    cwd: cwd ?? "",
    attachment: workingDiff.reviewAttachment,
    enabled: Boolean(cwd) && isActive,
  });

  const refreshSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.checkoutRefresh === true,
  );
  const runRefresh = useCheckoutGitActionsStore((state) => state.refresh);
  const isRefreshing =
    useCheckoutGitActionsStore((state) =>
      state.getStatus({ serverId, cwd: cwd ?? "", actionId: "refresh" }),
    ) === "pending";
  const refresh = useCallback(() => {
    if (!cwd || isRefreshing) {
      return;
    }
    void runRefresh({ serverId, cwd }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("workspace.git.diff.failedRefresh"));
    });
  }, [cwd, isRefreshing, runRefresh, serverId, t, toast]);

  const expandedPathSet = useMemo(
    () => (expandedPaths === null ? null : new Set(expandedPaths)),
    [expandedPaths],
  );
  const allFilesExpanded =
    workingDiff.files.length > 0 &&
    (expandedPathSet === null || workingDiff.files.every((file) => expandedPathSet.has(file.path)));
  const toggleExpandAll = useCallback(() => {
    setExpandedPaths(allFilesExpanded ? [] : null);
  }, [allFilesExpanded]);
  const mode = useMemo(
    () => ({
      kind: "working_tab" as const,
      expandedPaths,
      reviewActions: workingDiff.reviewActions,
      focusPath: target.focusPath,
      focusRequestId: target.focusRequestId,
      onExpandedPathsChange: setExpandedPaths,
    }),
    [expandedPaths, target.focusPath, target.focusRequestId, workingDiff.reviewActions],
  );

  const baseRefLabel = workingDiff.baseRef?.replace(/^refs\/(heads|remotes)\//, "") ?? "";
  return (
    <View style={styles.container} testID="working-diff-panel">
      <View style={styles.toolbar}>
        <DiffModeMenu
          diffMode={workingDiff.diffMode}
          committedDescription={baseRefLabel || undefined}
          testIDPrefix="working-diff"
          onSelectUncommitted={workingDiff.selectUncommitted}
          onSelectBase={workingDiff.selectBase}
        />
        <View style={styles.toolbarActions} testID="working-diff-toolbar">
          {panelPreferences.canUseSplitLayout ? (
            <DiffLayoutToggle
              layout={panelPreferences.preferences.layout}
              isMobile={panelPreferences.isCompact}
              testID="working-diff-toggle-layout"
              onToggle={panelPreferences.toggleLayout}
            />
          ) : null}
          {workingDiff.files.length > 0 ? (
            <DiffFilesToolbar
              allFileDiffsExpanded={allFilesExpanded}
              isMobile={panelPreferences.isCompact}
              testID="working-diff-toggle-expand-all"
              onToggleExpandAll={toggleExpandAll}
            />
          ) : null}
          <DiffOptionsMenu
            hideWhitespace={panelPreferences.preferences.hideWhitespace}
            isMobile={panelPreferences.isCompact}
            isRefreshing={isRefreshing}
            refreshSupported={refreshSupported}
            testIDPrefix="working-diff"
            wrapLines={panelPreferences.preferences.wrapLines}
            onRefresh={refresh}
            onToggleHideWhitespace={panelPreferences.toggleHideWhitespace}
            onToggleWrapLines={panelPreferences.toggleWrapLines}
          />
        </View>
      </View>
      <View style={styles.body}>
        <WorkingDiffBody
          cwd={cwd}
          isConnected={isConnected}
          workingDiff={workingDiff}
          hideWhitespace={panelPreferences.preferences.hideWhitespace}
          displayPreferences={panelPreferences.displayPreferences}
          mode={mode}
        />
      </View>
    </View>
  );
}

function CommitDiffPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const panelPreferences = useDiffPanelPreferences();
  invariant(target.kind === "commit_diff", "CommitDiffPanel requires commit_diff target");
  const { files, isLoading, error, capabilityMissing } = useCommitDiffFiles({
    serverId,
    cwd: cwd ?? "",
    sha: target.sha,
    enabled: Boolean(cwd),
  });
  const mode = useMemo(() => ({ kind: "commit" as const }), []);

  let body: ReactNode;
  if (!cwd) {
    body = <PanelState message={t("panels.diff.directoryMissing")} />;
  } else if (capabilityMissing) {
    body = (
      <PanelState
        message={t("panels.diff.capabilityMissing")}
        testID="commit-diff-capability-missing"
      />
    );
  } else if (error) {
    body = (
      <PanelState message={t("panels.diff.loadError")} tone="error" testID="commit-diff-error" />
    );
  } else if (isLoading && files.length === 0) {
    body = <PanelState message={t("workspace.tabs.loading")} testID="commit-diff-loading" />;
  } else if (files.length === 0) {
    body = <PanelState message={t("panels.diff.empty")} testID="commit-diff-empty" />;
  } else {
    body = (
      <SharedDiffView
        files={files}
        displayPreferences={panelPreferences.displayPreferences}
        mode={mode}
      />
    );
  }

  return (
    <View style={styles.container} testID="commit-diff-panel">
      {panelPreferences.canUseSplitLayout ? (
        <View style={styles.toolbar}>
          <View style={styles.toolbarActions} testID="commit-diff-toolbar">
            <DiffLayoutToggle
              layout={panelPreferences.preferences.layout}
              isMobile={panelPreferences.isCompact}
              testID="commit-diff-toggle-layout"
              onToggle={panelPreferences.toggleLayout}
            />
          </View>
        </View>
      ) : null}
      <View style={styles.body}>{body}</View>
    </View>
  );
}

function useWorkingDiffPanelDescriptor(): PanelDescriptor {
  const { t } = useTranslation();
  return {
    label: t("panels.diff.changesLabel"),
    subtitle: t("panels.diff.changesSubtitle"),
    tooltip: t("panels.diff.changesSubtitle"),
    titleState: "ready",
    icon: ThemedFileDiff,
    statusBucket: null,
  };
}

function useCommitDiffPanelDescriptor(
  target: Extract<WorkspaceTabTarget, { kind: "commit_diff" }>,
): PanelDescriptor {
  const { t } = useTranslation();
  return {
    label: target.sha.slice(0, 7),
    subtitle: t("panels.diff.commitSubtitle"),
    tooltip: target.sha,
    titleState: "ready",
    icon: ThemedGitCommitHorizontal,
    statusBucket: null,
  };
}

export const workingDiffPanelRegistration: PanelRegistration<"working_diff"> = {
  kind: "working_diff",
  component: WorkingDiffPanel,
  useDescriptor: useWorkingDiffPanelDescriptor,
};

export const commitDiffPanelRegistration: PanelRegistration<"commit_diff"> = {
  kind: "commit_diff",
  component: CommitDiffPanel,
  useDescriptor: useCommitDiffPanelDescriptor,
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
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    flexShrink: 0,
  },
  toolbarActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
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
