import { useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FileDiff, GitCommitHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useIsCompactFormFactor } from "@/constants/layout";
import { PaneContentToolbar } from "@/components/ui/pane-content-toolbar";
import { isWeb } from "@/constants/platform";
import { DiffDocument } from "@/git/diff-document";
import { ChangesSurface, DiffLayoutToggle, resolveDiffLayout } from "@/git/diff-pane";
import { useCommitDiffFiles } from "@/git/use-diff-files";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useAppSettings } from "@/hooks/use-settings";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useAddFileToChat } from "@/panels/use-add-file-to-chat";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { defaultChangesState, changesStateSchema } from "@/panels/changes/state";
import { usePanelState } from "@/panels/use-panel-state";

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

function WorkingDiffPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, openFileInWorkspace } = usePaneContext();
  const [changesState, setChangesState] = usePanelState(changesStateSchema, defaultChangesState);
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const isActive = useRetainedPanelActive();
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  invariant(target.kind === "working_diff", "WorkingDiffPanel requires working_diff target");

  const handleOpenFile = useCallback(
    (path: string) => openFileInWorkspace({ location: { path }, disposition: "side" }),
    [openFileInWorkspace],
  );

  if (!cwd) {
    return <PanelState message={t("panels.diff.directoryMissing")} />;
  }

  return (
    <View style={styles.container} testID="working-diff-panel">
      <ChangesSurface
        serverId={serverId}
        workspaceId={workspaceId}
        cwd={cwd}
        enabled={isActive}
        host="panel"
        focusPath={target.focusPath}
        focusRequestId={target.focusRequestId}
        onOpenFile={handleOpenFile}
        onAddToChat={canAddToChat ? addFile : undefined}
        state={changesState}
        onStateChange={setChangesState}
      />
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
      <DiffDocument
        files={files}
        displayPreferences={panelPreferences.displayPreferences}
        mode={mode}
      />
    );
  }

  return (
    <View style={styles.container} testID="commit-diff-panel">
      {panelPreferences.canUseSplitLayout ? (
        <PaneContentToolbar style={styles.toolbar} testID="commit-diff-header">
          <View style={styles.toolbarActions} testID="commit-diff-toolbar">
            <DiffLayoutToggle
              layout={panelPreferences.preferences.layout}
              isMobile={panelPreferences.isCompact}
              testID="commit-diff-toggle-layout"
              onToggle={panelPreferences.toggleLayout}
            />
          </View>
        </PaneContentToolbar>
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
  resourceKey: () => "working_diff",
};

export const commitDiffPanelRegistration: PanelRegistration<"commit_diff"> = {
  kind: "commit_diff",
  component: CommitDiffPanel,
  useDescriptor: useCommitDiffPanelDescriptor,
  resourceKey: (target) => target.sha,
};

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
