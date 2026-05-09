import React, { useCallback, useState, type ReactElement } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { router } from "expo-router";
import { FolderPlus, MoreVertical, Plus, Settings, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isNative as platformIsNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import {
  clearWorkspaceArchivePending,
  markWorkspaceArchivePending,
} from "@/contexts/session-workspace-upserts";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { buildProjectSettingsRoute } from "@/utils/host-routes";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-execution";

export interface SidebarProjectCreateButtonConfig {
  onPress: () => void;
  accessibilityLabel: string;
  testID: string;
  tooltipLabel: string;
  icon: "folder-plus" | "plus";
  showShortcutHint?: boolean;
}

export interface SidebarProjectTrailingActionsProps {
  projectKey: string;
  serverId: string | null;
  isHovered: boolean;
  projectName?: string;
  onRemoveProject?: () => void;
  removeProjectStatus?: "idle" | "pending" | "success";
  workspaces?: readonly SidebarWorkspaceEntry[];
  createButton: SidebarProjectCreateButtonConfig | null;
}

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPlus = withUnistyles(Plus);
const ThemedSettings = withUnistyles(Settings);
const ThemedTrash2 = withUnistyles(Trash2);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const trash2LeadingIcon = <ThemedTrash2 size={14} uniProps={foregroundMutedColorMapping} />;
const settingsLeadingIcon = <ThemedSettings size={14} uniProps={foregroundMutedColorMapping} />;

export function SidebarProjectTrailingActions({
  projectKey,
  serverId,
  isHovered,
  projectName,
  onRemoveProject,
  removeProjectStatus,
  workspaces = [],
  createButton,
}: SidebarProjectTrailingActionsProps): ReactElement {
  const isMobileBreakpoint = useIsCompactFormFactor();
  const actionsVisible = isHovered || platformIsNative || isMobileBreakpoint;
  const fallbackRemoval = useSidebarProjectRemoval({
    projectKey,
    projectName,
    serverId,
    workspaces,
  });
  const resolvedRemoveProject = onRemoveProject ?? fallbackRemoval.onRemoveProject;
  const resolvedRemoveProjectStatus = removeProjectStatus ?? fallbackRemoval.removeProjectStatus;

  return (
    <View style={styles.projectTrailingActions}>
      {createButton ? (
        <ProjectCreateButton actionsVisible={actionsVisible} createButton={createButton} />
      ) : null}
      <View
        style={!actionsVisible && styles.projectKebabButtonHidden}
        pointerEvents={actionsVisible ? "auto" : "none"}
      >
        <ProjectKebabMenu
          projectKey={projectKey}
          onRemoveProject={resolvedRemoveProject}
          removeProjectStatus={resolvedRemoveProjectStatus}
        />
      </View>
    </View>
  );
}

function ProjectCreateButton({
  actionsVisible,
  createButton,
}: {
  actionsVisible: boolean;
  createButton: SidebarProjectCreateButtonConfig;
}): ReactElement {
  return (
    <NewWorktreeButton
      accessibilityLabel={createButton.accessibilityLabel}
      icon={createButton.icon}
      onPress={createButton.onPress}
      visible={actionsVisible}
      showShortcutHint={createButton.showShortcutHint ?? false}
      testID={createButton.testID}
      tooltipLabel={createButton.tooltipLabel}
    />
  );
}

function useSidebarProjectRemoval({
  projectKey,
  projectName,
  serverId,
  workspaces,
}: {
  projectKey: string;
  projectName?: string;
  serverId: string | null;
  workspaces: readonly SidebarWorkspaceEntry[];
}): {
  onRemoveProject: () => void;
  removeProjectStatus: "idle" | "pending";
} {
  const toast = useToast();
  const [isRemovingProject, setIsRemovingProject] = useState(false);
  const displayName = projectName ?? projectKey;

  const handleRemoveProject = useCallback(() => {
    if (isRemovingProject || !serverId) {
      return;
    }

    void (async () => {
      const confirmed = await confirmDialog({
        title: "Remove project?",
        message: `Remove "${displayName}" from the sidebar?\n\nFiles on disk will not be changed.`,
        confirmLabel: "Remove",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) {
        toast.error("Host is not connected");
        return;
      }

      setIsRemovingProject(true);
      const snapshots = new Map(
        workspaces.map((workspace) => [
          workspace.workspaceId,
          hideWorkspaceOptimistically(workspace),
        ]),
      );

      const isRejected = (r: PromiseSettledResult<unknown>) => r.status === "rejected";
      void Promise.allSettled(
        workspaces.map(async (ws) => {
          try {
            const payload = await client.archiveWorkspace(ws.workspaceId);
            if (payload.error) {
              throw new Error(payload.error);
            }
          } catch (error) {
            restoreOptimisticallyHiddenWorkspace({
              serverId,
              workspaceId: ws.workspaceId,
              snapshot: snapshots.get(ws.workspaceId) ?? null,
            });
            throw error;
          }
        }),
      ).then((results) => {
        const failed = results.filter(isRejected);
        if (failed.length > 0) {
          toast.error("Failed to remove some workspaces");
        }
        setIsRemovingProject(false);
        return;
      });
    })();
  }, [displayName, isRemovingProject, serverId, toast, workspaces]);

  return {
    onRemoveProject: handleRemoveProject,
    removeProjectStatus: isRemovingProject ? "pending" : "idle",
  };
}

function hideWorkspaceOptimistically(workspace: SidebarWorkspaceEntry): WorkspaceDescriptor | null {
  const workspaces = useSessionStore.getState().sessions[workspace.serverId]?.workspaces;
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: workspace.workspaceId,
  });
  const snapshot = workspaceKey ? (workspaces?.get(workspaceKey) ?? null) : null;
  markWorkspaceArchivePending({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
    workspaceDirectory: workspace.workspaceDirectory,
  });
  useSessionStore.getState().removeWorkspace(workspace.serverId, workspace.workspaceId);
  return snapshot;
}

function restoreOptimisticallyHiddenWorkspace(input: {
  serverId: string;
  workspaceId: string;
  snapshot: WorkspaceDescriptor | null;
}): void {
  clearWorkspaceArchivePending({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  if (input.snapshot) {
    useSessionStore.getState().mergeWorkspaces(input.serverId, [input.snapshot]);
  }
}

function projectKebabStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.projectKebabButton, hovered && styles.projectKebabButtonHovered];
}

function renderKebabTriggerIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreVertical
      size={14}
      uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
    />
  );
}

function ProjectKebabMenu({
  projectKey,
  onRemoveProject,
  removeProjectStatus,
}: {
  projectKey: string;
  onRemoveProject: () => void;
  removeProjectStatus: "idle" | "pending" | "success";
}) {
  const handleOpenProjectSettings = useCallback(() => {
    if (projectKey.trim().length === 0) return;
    router.navigate(buildProjectSettingsRoute(projectKey));
  }, [projectKey]);
  const canOpenProjectSettings = projectKey.trim().length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={projectKebabStyle}
        accessibilityRole="button"
        accessibilityLabel="Project actions"
        testID={`sidebar-project-kebab-${projectKey}`}
      >
        {renderKebabTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        {canOpenProjectSettings ? (
          <DropdownMenuItem
            testID={`sidebar-project-menu-open-settings-${projectKey}`}
            leading={settingsLeadingIcon}
            onSelect={handleOpenProjectSettings}
          >
            Open project settings
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          testID={`sidebar-project-menu-remove-${projectKey}`}
          leading={trash2LeadingIcon}
          status={removeProjectStatus}
          pendingLabel="Removing..."
          onSelect={onRemoveProject}
        >
          Remove project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NewWorktreeButton({
  accessibilityLabel,
  icon,
  onPress,
  visible,
  loading = false,
  testID,
  showShortcutHint = false,
  tooltipLabel,
}: {
  accessibilityLabel: string;
  icon: "folder-plus" | "plus";
  onPress: () => void;
  visible: boolean;
  loading?: boolean;
  testID: string;
  showShortcutHint?: boolean;
  tooltipLabel: string;
}) {
  const newWorktreeKeys = useShortcutKeys("new-worktree");

  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.projectIconActionButton,
      !visible && styles.projectIconActionButtonHidden,
      (Boolean(hovered) || pressed) && !loading && styles.projectIconActionButtonHovered,
    ],
    [visible, loading],
  );

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );

  const renderIcon = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => {
      if (loading) {
        return <ThemedActivityIndicator size={14} uniProps={foregroundMutedColorMapping} />;
      }
      const uniProps = hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping;
      if (icon === "plus") {
        return <ThemedPlus size={15} uniProps={uniProps} />;
      }
      return <ThemedFolderPlus size={15} uniProps={uniProps} />;
    },
    [icon, loading],
  );

  return (
    <View style={styles.projectTrailingControlSlot} pointerEvents={visible ? "auto" : "none"}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild disabled={!visible}>
          <Pressable
            style={pressableStyle}
            onPress={handlePress}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            testID={testID}
          >
            {renderIcon}
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <View style={styles.projectActionTooltipRow}>
            <Text style={styles.projectActionTooltipText}>{tooltipLabel}</Text>
            {showShortcutHint && newWorktreeKeys ? (
              <Shortcut chord={newWorktreeKeys} style={styles.projectActionTooltipShortcut} />
            ) : null}
          </View>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  projectIconActionButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  projectIconActionButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  projectIconActionButtonHidden: {
    opacity: 0,
  },
  projectTrailingActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
  },
  projectKebabButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  projectKebabButtonHidden: {
    opacity: 0,
  },
  projectKebabButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  projectTrailingControlSlot: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  projectActionTooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  projectActionTooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  projectActionTooltipShortcut: {},
}));
