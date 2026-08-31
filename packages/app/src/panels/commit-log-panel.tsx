import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { History } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import type { CommitLogScope } from "@getpaseo/protocol/messages";
import { useIsCompactFormFactor } from "@/constants/layout";
import { CommitLogSurface } from "@/git/commit-log/commit-log-surface";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { commitLogStateSchema, defaultCommitLogState } from "@/panels/commit-log/state";
import { usePanelState } from "@/panels/use-panel-state";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

const ThemedHistory = withUnistyles(History);

function CommitLogPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, openPreferredTarget } = usePaneContext();
  const [state, setState] = usePanelState(commitLogStateSchema, defaultCommitLogState);
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const isCompact = useIsCompactFormFactor();
  invariant(target.kind === "commit_log", "CommitLogPanel requires a commit_log target");

  const handleScopeChange = useCallback((scope: CommitLogScope) => setState({ scope }), [setState]);
  const handleCommitPress = useCallback(
    (sha: string) => openPreferredTarget({ kind: "commit_diff", sha }, "diffs"),
    [openPreferredTarget],
  );

  if (!cwd) {
    return (
      <View style={styles.centerState} testID="commit-log-panel">
        <Text style={styles.mutedText}>{t("panels.commitLog.directoryMissing")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="commit-log-panel">
      <CommitLogSurface
        serverId={serverId}
        cwd={cwd}
        scope={state.scope}
        onScopeChange={handleScopeChange}
        onCommitPress={handleCommitPress}
        compact={isCompact}
      />
    </View>
  );
}

const commitLogPresentation = {
  label: (t) => t("panels.commitLog.label"),
  subtitle: (t) => t("panels.commitLog.subtitle"),
  tooltip: (t) => t("panels.commitLog.tooltip"),
  icon: ThemedHistory,
} satisfies PanelPresentation;

export const commitLogPanelRegistration = definePanel("commit_log", {
  component: CommitLogPanel,
  presentation: commitLogPresentation,
});

const styles = StyleSheet.create((theme) => ({
  container: {
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
}));
