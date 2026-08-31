import { useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  Columns2,
  FileDiff,
  GitCommitHorizontal,
  ListChevronsDownUp,
  ListChevronsUpDown,
  WrapText,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  PaneContentToolbar,
  paneContentToolbarIconSize,
  ToolbarButton,
} from "@/components/ui/pane-content-toolbar";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { isWeb } from "@/constants/platform";
import { DiffDocument } from "@/git/diff-document";
import { ChangesSurface, resolveDiffLayout } from "@/git/diff-pane";
import { useCommitDiffFiles } from "@/git/use-diff-files";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useAppSettings } from "@/hooks/use-settings";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor, type PanelPresentation } from "@/panels/panel-registry";
import { useAddFileToChat } from "@/panels/use-add-file-to-chat";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { defaultChangesState, changesStateSchema } from "@/panels/changes/state";
import { commitDiffStateSchema, defaultCommitDiffState } from "@/panels/commit-diff/state";
import { usePanelState } from "@/panels/use-panel-state";
import { RenderProfile } from "@/utils/render-profiler";

const ThemedFileDiff = withUnistyles(FileDiff);
const ThemedGitCommitHorizontal = withUnistyles(GitCommitHorizontal);
const ThemedColumns2 = withUnistyles(Columns2);
const ThemedListChevronsDownUp = withUnistyles(ListChevronsDownUp);
const ThemedListChevronsUpDown = withUnistyles(ListChevronsUpDown);
const ThemedWrapText = withUnistyles(WrapText);

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
  return {
    preferences,
    isCompact,
    canUseSplitLayout,
    displayPreferences,
    toggleLayout,
    toggleWrapLines,
  };
}

function CommitDiffToolbar({
  compact,
  collapsible,
  allFilesCollapsed,
  onToggleCollapseAll,
  layout,
  onToggleLayout,
  wrapLines,
  onToggleWrapLines,
}: {
  compact: boolean;
  collapsible: boolean;
  allFilesCollapsed: boolean;
  onToggleCollapseAll: () => void;
  /** Null when the pane is too narrow for side-by-side. */
  layout: "unified" | "split" | null;
  onToggleLayout: () => void;
  wrapLines: boolean;
  onToggleWrapLines: () => void;
}) {
  const { t } = useTranslation();
  const iconSize = paneContentToolbarIconSize(compact);
  return (
    <PaneContentToolbar style={styles.toolbar} testID="commit-diff-header">
      <View style={styles.toolbarActions} testID="commit-diff-toolbar">
        {collapsible ? (
          <ToolbarButton
            compact={compact}
            label={t(
              allFilesCollapsed
                ? "workspace.git.diff.expandAllFiles"
                : "workspace.git.diff.collapseAllFiles",
            )}
            testID="commit-diff-toggle-collapse-all"
            onPress={onToggleCollapseAll}
          >
            {allFilesCollapsed ? (
              <ThemedListChevronsUpDown size={iconSize} uniProps={extraMutedIconColorMapping} />
            ) : (
              <ThemedListChevronsDownUp size={iconSize} uniProps={extraMutedIconColorMapping} />
            )}
          </ToolbarButton>
        ) : null}
        {layout ? (
          <ToolbarButton
            compact={compact}
            label={t(
              layout === "split"
                ? "workspace.git.diff.switchToUnified"
                : "workspace.git.diff.switchToSplit",
            )}
            selected={layout === "split"}
            testID="commit-diff-toggle-layout"
            onPress={onToggleLayout}
          >
            <ThemedColumns2 size={iconSize} uniProps={extraMutedIconColorMapping} />
          </ToolbarButton>
        ) : null}
        <ToolbarButton
          compact={compact}
          label={t(
            wrapLines ? "workspace.git.diff.scrollLongLines" : "workspace.git.diff.wrapLongLines",
          )}
          selected={wrapLines}
          testID="commit-diff-toggle-wrap"
          onPress={onToggleWrapLines}
        >
          <ThemedWrapText size={iconSize} uniProps={extraMutedIconColorMapping} />
        </ToolbarButton>
      </View>
    </PaneContentToolbar>
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

function resolveChangesPresentation(
  isTree: boolean,
  inlineDiff: boolean,
): "tree" | "diff" | "combined" {
  if (!isTree) return "diff";
  return inlineDiff ? "combined" : "tree";
}

function ChangesPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, tabId, target, openPreferredTarget, openTargetToSide } =
    usePaneContext();
  const [changesState, setChangesState] = usePanelState(changesStateSchema, defaultChangesState);
  const { preferences } = useChangesPreferences();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const isActive = useRetainedPanelActive();
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  invariant(
    target.kind === "working_diff" || target.kind === "changes_tree",
    "ChangesPanel requires working_diff or changes_tree target",
  );
  const isTree = target.kind === "changes_tree";

  const handleOpenFile = useCallback(
    (path: string) => openPreferredTarget({ kind: "file", path }, isTree ? "diffs" : "diffFiles"),
    [isTree, openPreferredTarget],
  );

  const handleSelectDiffFile = useCallback(
    (path: string) =>
      openPreferredTarget(
        { kind: "working_diff", focusPath: path, focusRequestId: Date.now() },
        "diffs",
      ),
    [openPreferredTarget],
  );
  const handleOpenDiffToSide = useCallback(
    (path: string) =>
      openTargetToSide?.({ kind: "working_diff", focusPath: path, focusRequestId: Date.now() }),
    [openTargetToSide],
  );

  if (!cwd) {
    return <PanelState message={t("panels.diff.directoryMissing")} />;
  }

  const presentation = resolveChangesPresentation(isTree, preferences.inlineDiff);
  const testID = isTree ? "changes-tree-panel" : "working-diff-panel";
  const profileId = isTree ? `ChangesTreePanel:${tabId}` : `WorkingDiffPanel:${tabId}`;

  return (
    <View style={styles.container} testID={testID}>
      <RenderProfile id={profileId}>
        <ChangesSurface
          serverId={serverId}
          workspaceId={workspaceId}
          cwd={cwd}
          enabled={isActive}
          presentation={presentation}
          modeScope={tabId}
          focusPath={target.kind === "working_diff" ? target.focusPath : undefined}
          focusRequestId={target.kind === "working_diff" ? target.focusRequestId : undefined}
          onSelectDiffFile={isTree ? handleSelectDiffFile : undefined}
          onOpenFile={handleOpenFile}
          onOpenToSide={isTree && openTargetToSide ? handleOpenDiffToSide : undefined}
          onAddToChat={canAddToChat ? addFile : undefined}
          state={changesState}
          onStateChange={setChangesState}
        />
      </RenderProfile>
    </View>
  );
}

function CommitDiffPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const panelPreferences = useDiffPanelPreferences();
  const [panelState, setPanelState] = usePanelState(commitDiffStateSchema, defaultCommitDiffState);
  invariant(target.kind === "commit_diff", "CommitDiffPanel requires commit_diff target");
  const { files, isLoading, error, capabilityMissing } = useCommitDiffFiles({
    serverId,
    cwd: cwd ?? "",
    sha: target.sha,
    enabled: Boolean(cwd),
  });
  const mode = useMemo(() => ({ kind: "commit" as const }), []);
  const collapsedFilePaths = panelState.collapsedFilePaths;
  const updateCollapsedFilePaths = useCallback(
    (paths: string[]) => setPanelState({ collapsedFilePaths: paths }),
    [setPanelState],
  );
  const collapseState = useMemo(
    () => ({ paths: collapsedFilePaths, onChange: updateCollapsedFilePaths }),
    [collapsedFilePaths, updateCollapsedFilePaths],
  );
  const allFilesCollapsed =
    files.length > 0 && files.every((file) => collapsedFilePaths.includes(file.path));
  const handleToggleCollapseAll = useCallback(
    () => updateCollapsedFilePaths(allFilesCollapsed ? [] : files.map((file) => file.path)),
    [allFilesCollapsed, files, updateCollapsedFilePaths],
  );

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
      <DiffDocument
        files={files}
        collapseState={collapseState}
        displayPreferences={panelPreferences.displayPreferences}
        mode={mode}
      />
    );
  }

  return (
    <View style={styles.container} testID="commit-diff-panel">
      <CommitDiffToolbar
        compact={panelPreferences.isCompact}
        collapsible={files.length > 0}
        allFilesCollapsed={allFilesCollapsed}
        onToggleCollapseAll={handleToggleCollapseAll}
        layout={panelPreferences.canUseSplitLayout ? panelPreferences.preferences.layout : null}
        onToggleLayout={panelPreferences.toggleLayout}
        wrapLines={panelPreferences.preferences.wrapLines}
        onToggleWrapLines={panelPreferences.toggleWrapLines}
      />
      <View style={styles.body}>{body}</View>
    </View>
  );
}

const workingDiffPresentation = {
  label: (t) => t("panels.diff.diffLabel"),
  subtitle: (t) => t("panels.diff.changesSubtitle"),
  tooltip: (t) => t("panels.diff.changesSubtitle"),
  icon: ThemedFileDiff,
} satisfies PanelPresentation;

const changesTreePresentation = {
  label: (t) => t("panels.diff.changesLabel"),
  subtitle: (t) => t("panels.diff.changesSubtitle"),
  tooltip: (t) => t("panels.diff.changesSubtitle"),
  icon: ThemedFileDiff,
} satisfies PanelPresentation;

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

export const workingDiffPanelRegistration = definePanel("working_diff", {
  component: ChangesPanel,
  presentation: workingDiffPresentation,
});

export const changesTreePanelRegistration = definePanel("changes_tree", {
  component: ChangesPanel,
  presentation: changesTreePresentation,
});

export const commitDiffPanelRegistration = definePanel("commit_diff", {
  component: CommitDiffPanel,
  useDescriptor: useCommitDiffPanelDescriptor,
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingRight: theme.spacing[2],
  },
  toolbarActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
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
