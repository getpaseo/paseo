import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FileDiff, ListChevronsDownUp, ListChevronsUpDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor, WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { SharedDiffView } from "@/git/diff-pane";
import { useCheckoutDiffQuery } from "@/git/use-diff-query";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useAppSettings } from "@/hooks/use-settings";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { buildReviewDraftKey, useInlineReviewController } from "@/review";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import type { Theme } from "@/styles/theme";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedFileDiff = withUnistyles(FileDiff);
const ThemedListChevronsDownUp = withUnistyles(ListChevronsDownUp);
const ThemedListChevronsUpDown = withUnistyles(ListChevronsUpDown);

function toolbarButtonStyle({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) {
  return [styles.toolbarButton, (Boolean(hovered) || pressed) && styles.toolbarButtonActive];
}

function WorkingDiffPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isActive = useRetainedPanelActive();
  const { settings } = useAppSettings();
  const { preferences, updatePreferences } = useChangesPreferences();
  const isCompact = useIsCompactFormFactor();
  const [expandedPaths, setExpandedPaths] = useState<string[] | null>(null);
  invariant(target.kind === "working_diff", "WorkingDiffPanel requires working_diff target");

  const { files, payloadError, isLoading } = useCheckoutDiffQuery({
    serverId,
    cwd: cwd ?? "",
    mode: target.mode,
    baseRef: target.baseRef ?? undefined,
    ignoreWhitespace: target.ignoreWhitespace,
    enabled: Boolean(cwd) && isActive,
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
  const canUseSplitLayout = isWeb && !isCompact;
  const effectiveLayout = canUseSplitLayout ? preferences.layout : "unified";
  const layoutOptions = useMemo(
    () => [
      {
        value: "unified" as const,
        label: t("workspace.git.diff.unified"),
        testID: "working-diff-layout-unified",
      },
      {
        value: "split" as const,
        label: t("workspace.git.diff.split"),
        testID: "working-diff-layout-split",
      },
    ],
    [t],
  );
  const handleLayoutChange = useCallback(
    (layout: "unified" | "split") => {
      void updatePreferences({ layout });
    },
    [updatePreferences],
  );
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
  const allFilesExpanded =
    files.length > 0 &&
    (expandedPaths === null || files.every((file) => expandedPaths.includes(file.path)));
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
    bodyContent = <PanelState message={t("panels.diff.empty")} testID="working-diff-empty" />;
  } else {
    bodyContent = (
      <SharedDiffView files={files} displayPreferences={displayPreferences} mode={workingTabMode} />
    );
  }

  return (
    <View style={styles.container} testID="working-diff-panel">
      {canUseSplitLayout ? (
        <View style={styles.toolbar} testID="working-diff-toolbar">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(
              allFilesExpanded ? "workspace.git.diff.collapseAll" : "workspace.git.diff.expandAll",
            )}
            onPress={handleToggleExpandAll}
            style={toolbarButtonStyle}
            testID="working-diff-toggle-expand-all"
          >
            {allFilesExpanded ? (
              <ThemedListChevronsDownUp size={16} uniProps={mutedColorMapping} />
            ) : (
              <ThemedListChevronsUpDown size={16} uniProps={mutedColorMapping} />
            )}
          </Pressable>
          <SegmentedControl
            options={layoutOptions}
            value={preferences.layout}
            onValueChange={handleLayoutChange}
            size="sm"
            testID="working-diff-layout-control"
          />
        </View>
      ) : null}
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
  toolbarButton: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  toolbarButtonActive: {
    backgroundColor: theme.colors.surface2,
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
