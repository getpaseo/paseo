import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { GitCommitHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useAppSettings } from "@/hooks/use-settings";
import { SharedDiffView } from "@/git/diff-pane";
import { useCommitDiffFiles } from "@/git/use-diff-files";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";

const ThemedGitCommitHorizontal = withUnistyles(GitCommitHorizontal);

function CommitDiffPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const { settings } = useAppSettings();
  const { preferences } = useChangesPreferences();
  const isCompact = useIsCompactFormFactor();
  invariant(target.kind === "commit_diff", "CommitDiffPanel requires commit_diff target");

  const { files, isLoading, error, capabilityMissing } = useCommitDiffFiles({
    serverId,
    cwd: cwd ?? "",
    sha: target.sha,
    enabled: Boolean(cwd),
  });
  const effectiveLayout = isWeb && !isCompact ? preferences.layout : "unified";
  const displayPreferences = useMemo(
    () => ({
      layout: effectiveLayout,
      wrapLines: preferences.wrapLines,
      codeFontSize: settings.codeFontSize,
      monoFontFamily: settings.monoFontFamily,
    }),
    [effectiveLayout, preferences.wrapLines, settings.codeFontSize, settings.monoFontFamily],
  );
  const commitMode = useMemo(() => ({ kind: "commit" as const }), []);

  if (!cwd) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.mutedText}>{t("panels.diff.directoryMissing")}</Text>
      </View>
    );
  }

  if (capabilityMissing) {
    return (
      <View style={styles.centerState} testID="commit-diff-capability-missing">
        <Text style={styles.mutedText}>{t("panels.diff.capabilityMissing")}</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.centerState} testID="commit-diff-error">
        <Text style={styles.errorText}>{t("panels.diff.loadError")}</Text>
      </View>
    );
  }
  if (isLoading && files.length === 0) {
    return (
      <View style={styles.centerState} testID="commit-diff-loading">
        <Text style={styles.mutedText}>{t("workspace.tabs.loading")}</Text>
      </View>
    );
  }
  if (files.length === 0) {
    return (
      <View style={styles.centerState} testID="commit-diff-empty">
        <Text style={styles.mutedText}>{t("panels.diff.empty")}</Text>
      </View>
    );
  }

  return <SharedDiffView files={files} displayPreferences={displayPreferences} mode={commitMode} />;
}

function useCommitDiffPanelDescriptor(
  target: Extract<WorkspaceTabTarget, { kind: "commit_diff" }>,
): PanelDescriptor {
  const { t } = useTranslation();
  return {
    label: target.sha.slice(0, 7),
    subtitle: t("panels.diff.commitSubtitle"),
    titleState: "ready",
    icon: ThemedGitCommitHorizontal,
    statusBucket: null,
  };
}

export const commitDiffPanelRegistration: PanelRegistration<"commit_diff"> = {
  kind: "commit_diff",
  component: CommitDiffPanel,
  useDescriptor: useCommitDiffPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
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
