import { memo, useCallback, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import {
  FileDiff,
  FolderTree,
  GitPullRequest,
  SquarePen,
  SquareTerminal,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { Theme } from "@/styles/theme";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

const ThemedFileDiff = withUnistyles(FileDiff);
const ThemedFolderTree = withUnistyles(FolderTree);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedSquarePen = withUnistyles(SquarePen);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const FILES_ICON = <ThemedFolderTree size={16} uniProps={mutedColorMapping} />;
const CHANGES_ICON = <ThemedFileDiff size={16} uniProps={mutedColorMapping} />;
const PULL_REQUEST_ICON = <ThemedGitPullRequest size={16} uniProps={mutedColorMapping} />;
const AGENT_ICON = <ThemedSquarePen size={16} uniProps={mutedColorMapping} />;
const TERMINAL_ICON = <ThemedSquareTerminal size={16} uniProps={mutedColorMapping} />;

const FILES_TARGET: WorkspaceTabTarget = { kind: "files" };
const CHANGES_TARGET: WorkspaceTabTarget = { kind: "working_diff" };
const PULL_REQUEST_TARGET: WorkspaceTabTarget = { kind: "pull_request" };

/** The launcher's own binding, or nothing when the action has no shortcut. */
function LauncherShortcut({ actionId }: { actionId: string }): ReactElement | null {
  const keys = useShortcutKeys(actionId);
  return keys ? <Shortcut chord={keys} /> : null;
}

function getLauncherRowStyle({ pressed, hovered }: PressableStateCallbackType) {
  return [styles.row, hovered && styles.rowHovered, pressed && styles.pressed];
}

/**
 * One launcher. This is a row with a trailing slot, not a `<Button>` — the shortcut
 * badge sits opposite the label on a shared rail, which is the list-row anatomy in
 * `docs/design.md` §12 rather than anything the button primitive can express.
 */
function LauncherRow({
  label,
  icon,
  onPress,
  children,
}: {
  label: string;
  icon: ReactNode;
  onPress: () => void;
  children?: ReactNode;
}): ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={getLauncherRowStyle}
    >
      {icon}
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowSpacer} />
      {children}
    </Pressable>
  );
}

export interface WorkspacePaneEmptyStateProps {
  paneId: string;
  /** Changes needs a Git workspace; the pull request needs one that has been detected. */
  showChanges: boolean;
  showPullRequest: boolean;
  onOpenView: (input: { paneId: string; target: WorkspaceTabTarget }) => void;
  onCreateAgent: (input: { paneId: string }) => void;
  onCreateTerminal: (input: { paneId: string }) => void;
  /**
   * Dismisses the pane. Absent on the last pane standing, where there is nothing
   * for the layout to fall back to. What "close" means to this pane — hiding the
   * Side panel, removing an ordinary split — belongs to the layout store.
   */
  onClosePane: (() => void) | null;
}

export const WorkspacePaneEmptyState = memo(function WorkspacePaneEmptyState({
  paneId,
  showChanges,
  showPullRequest,
  onOpenView,
  onCreateAgent,
  onCreateTerminal,
  onClosePane,
}: WorkspacePaneEmptyStateProps): ReactElement {
  const { t } = useTranslation();

  const openFiles = useCallback(
    () => onOpenView({ paneId, target: FILES_TARGET }),
    [onOpenView, paneId],
  );
  const openChanges = useCallback(
    () => onOpenView({ paneId, target: CHANGES_TARGET }),
    [onOpenView, paneId],
  );
  const openPullRequest = useCallback(
    () => onOpenView({ paneId, target: PULL_REQUEST_TARGET }),
    [onOpenView, paneId],
  );
  const createAgent = useCallback(() => onCreateAgent({ paneId }), [onCreateAgent, paneId]);
  const createTerminal = useCallback(
    () => onCreateTerminal({ paneId }),
    [onCreateTerminal, paneId],
  );

  return (
    <View style={styles.container} testID="workspace-pane-empty-state">
      <View style={styles.rail}>
        <View style={styles.stack}>
          <LauncherRow
            label={t("workspace.tabs.actions.files")}
            icon={FILES_ICON}
            onPress={openFiles}
          >
            <LauncherShortcut actionId="workspace-tab-target-files" />
          </LauncherRow>
          {showChanges ? (
            <LauncherRow
              label={t("workspace.tabs.actions.changes")}
              icon={CHANGES_ICON}
              onPress={openChanges}
            >
              <LauncherShortcut actionId="workspace-tab-target-changes" />
            </LauncherRow>
          ) : null}
          {showPullRequest ? (
            <LauncherRow
              label={t("workspace.tabs.actions.pullRequest")}
              icon={PULL_REQUEST_ICON}
              onPress={openPullRequest}
            />
          ) : null}
          <LauncherRow
            label={t("workspace.tabs.actions.newAgent")}
            icon={AGENT_ICON}
            onPress={createAgent}
          >
            <LauncherShortcut actionId="workspace-tab-target-agent" />
          </LauncherRow>
          <LauncherRow
            label={t("workspace.tabs.actions.newTerminal")}
            icon={TERMINAL_ICON}
            onPress={createTerminal}
          >
            <LauncherShortcut actionId="workspace-terminal-new" />
          </LauncherRow>
        </View>
        {onClosePane ? (
          <Button variant="ghost" size="sm" style={styles.closePane} onPress={onClosePane}>
            {t("workspace.tabs.actions.closePane")}
          </Button>
        ) : null}
      </View>
    </View>
  );
});

// Wide enough for a shortcut badge to sit clear of the longest label, narrow enough
// that the stack still reads as one column in a half-width pane.
const LAUNCHER_RAIL_WIDTH = 380;

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  rail: {
    width: "100%",
    maxWidth: LAUNCHER_RAIL_WIDTH,
    gap: theme.spacing[3],
  },
  stack: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 44,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface3,
  },
  pressed: {
    opacity: 0.85,
  },
  rowLabel: {
    color: theme.colors.foreground,
  },
  rowSpacer: {
    flex: 1,
  },
  closePane: {
    alignSelf: "center",
  },
}));
