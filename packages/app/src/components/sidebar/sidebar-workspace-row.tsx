import { memo, useCallback, useMemo, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { View, Text, Pressable } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { DiffStat } from "@/components/diff-stat";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { toWorktreeArchiveRisk } from "@/git/worktree-archive-warning";
import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useClearWorkspaceAttention } from "@/hooks/use-clear-workspace-attention";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";
import { isNative as platformIsNative } from "@/constants/platform";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";
import { SidebarWorkspaceMenu } from "@/components/sidebar/sidebar-workspace-menu";
import {
  SidebarWorkspaceRowFrame,
  SidebarWorkspaceRowContent,
  SidebarWorkspaceTrailingActionBase,
  SidebarWorkspaceTrailingActionOverlay,
  SidebarWorkspaceTrailingActionSlot,
} from "@/components/sidebar/sidebar-workspace-row-content";

function noop() {}

interface SidebarWorkspaceRowProps {
  workspace: SidebarWorkspaceEntry;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  canCopyBranchName: boolean;
  onPress: () => void;
  /** Secondary line under the name (status grouping shows the project name). */
  subtitle?: string | null;
  /** Project grouping only: shows a transient "creating" affordance. */
  isCreating?: boolean;
  /** Project grouping only: drag-to-reorder wiring. Absent → not draggable. */
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

export function SidebarWorkspaceRow({
  workspace,
  selected,
  shortcutNumber,
  showShortcutBadge,
  canCopyBranchName,
  onPress,
  subtitle,
  isCreating = false,
  drag,
  isDragging = false,
  dragHandleProps,
}: SidebarWorkspaceRowProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [isHidingWorkspace, setIsHidingWorkspace] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const isArchiving = workspace.archivingAt !== null || isHidingWorkspace;

  const redirectAfterArchive = useCallback(() => {
    redirectIfArchivingActiveWorkspace({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
      activeWorkspaceSelection: selected
        ? { serverId: workspace.serverId, workspaceId: workspace.workspaceId }
        : null,
    });
  }, [selected, workspace]);

  const archiveController = useWorkspaceArchive({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
    workspaceKind: workspace.workspaceKind,
    name: workspace.name,
    ...toWorktreeArchiveRisk(workspace),
    onArchiveStarted: redirectAfterArchive,
    onSetHiding: setIsHidingWorkspace,
  });

  const handleArchive = useCallback(() => {
    if (isArchiving) {
      return;
    }
    archiveController.archive();
  }, [archiveController, isArchiving]);

  const handleCopyPath = useCallback(() => {
    let copyTargetDirectory: string;
    try {
      copyTargetDirectory = requireWorkspaceDirectory({
        workspaceId: workspace.workspaceId,
        workspaceDirectory: workspace.workspaceDirectory,
      });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("sidebar.workspace.toasts.workspacePathUnavailable"),
      );
      return;
    }
    void Clipboard.setStringAsync(copyTargetDirectory);
    toast.copied(t("sidebar.workspace.toasts.pathCopied"));
  }, [t, toast, workspace.workspaceDirectory, workspace.workspaceId]);

  const handleCopyBranchName = useCallback(() => {
    if (!workspace.currentBranch) {
      return;
    }
    void Clipboard.setStringAsync(workspace.currentBranch);
    toast.copied(t("sidebar.workspace.toasts.branchNameCopied"));
  }, [t, toast, workspace.currentBranch]);

  const renameMutation = useMutation({
    mutationFn: async (title: string) => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      await client.setWorkspaceTitle(workspace.workspaceId, title.length === 0 ? null : title);
    },
  });

  const handleOpenRename = useCallback(() => {
    setIsRenameOpen(true);
  }, []);

  const handleCloseRename = useCallback(() => {
    setIsRenameOpen(false);
  }, []);

  const handleSubmitRename = useCallback(
    async (value: string) => {
      await renameMutation.mutateAsync(value.trim());
    },
    [renameMutation],
  );

  const archiveShortcutKeys = useShortcutKeys("archive-workspace");
  const { hasClearableAttention, clearAttention } = useClearWorkspaceAttention({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
  });
  const handleMarkAsRead = useCallback(() => {
    void clearAttention().catch((error) => {
      toast.error(error instanceof Error ? error.message : "Failed to mark workspace as read");
    });
  }, [clearAttention, toast]);

  useKeyboardActionHandler({
    handlerId: `workspace-archive-${workspace.workspaceKey}`,
    actions: ["workspace.archive"],
    enabled: selected && !isArchiving,
    priority: 0,
    handle: () => {
      handleArchive();
      return true;
    },
  });

  return (
    <>
      <WorkspaceRowBody
        workspace={workspace}
        selected={selected}
        shortcutNumber={shortcutNumber}
        showShortcutBadge={showShortcutBadge}
        subtitle={subtitle}
        isCreating={isCreating}
        isArchiving={isArchiving}
        onPress={onPress}
        drag={drag}
        isDragging={isDragging}
        dragHandleProps={dragHandleProps}
        archiveLabel={t("sidebar.workspace.actions.archive")}
        archiveStatus={isArchiving ? "pending" : "idle"}
        archivePendingLabel={t("sidebar.workspace.actions.archiving")}
        onArchive={handleArchive}
        onCopyBranchName={canCopyBranchName ? handleCopyBranchName : undefined}
        onCopyPath={handleCopyPath}
        onRename={handleOpenRename}
        onMarkAsRead={hasClearableAttention ? handleMarkAsRead : undefined}
        archiveShortcutKeys={selected ? archiveShortcutKeys : null}
      />
      <AdaptiveRenameModal
        visible={isRenameOpen}
        title={t("sidebar.workspace.rename.title")}
        initialValue={workspace.title ?? workspace.name}
        placeholder={workspace.name}
        submitLabel={t("sidebar.workspace.rename.submit")}
        onClose={handleCloseRename}
        onSubmit={handleSubmitRename}
        testID={`sidebar-workspace-rename-modal-${workspace.workspaceKey}`}
      />
    </>
  );
}

interface WorkspaceRowBodyProps {
  workspace: SidebarWorkspaceEntry;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  subtitle?: string | null;
  isCreating: boolean;
  isArchiving: boolean;
  onPress: () => void;
  drag?: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  onArchive?: () => void;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  onRename?: () => void;
  onMarkAsRead?: () => void;
  archiveShortcutKeys?: ShortcutKey[][] | null;
}

function WorkspaceRowBody({
  workspace,
  selected,
  shortcutNumber,
  showShortcutBadge,
  subtitle,
  isCreating,
  isArchiving,
  onPress,
  drag,
  isDragging,
  dragHandleProps,
  archiveLabel,
  archiveStatus = "idle",
  archivePendingLabel,
  onArchive,
  onCopyBranchName,
  onCopyPath,
  onRename,
  onMarkAsRead,
  archiveShortcutKeys,
}: WorkspaceRowBodyProps) {
  const isTouchPlatform = platformIsNative;
  const draggable = Boolean(drag);
  const interaction = useLongPressDragInteraction({
    drag: drag ?? noop,
    menuController: null,
  });
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};

  const handlePress = useCallback(() => {
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    onPress();
  }, [interaction.didLongPressRef, onPress]);

  const accessibilityState = useMemo(() => ({ selected }), [selected]);

  return (
    <SidebarWorkspaceRowFrame workspace={workspace} isDragging={isDragging}>
      {({ isHovered, hoverHandlers }) => {
        const isDesktop = !isTouchPlatform;
        const showScriptsIcon = isDesktop && workspace.hasRunningScripts;
        const hasRunningService = workspace.scripts.some(
          (s) => s.lifecycle === "running" && (s.type ?? "service") === "service",
        );
        let scriptIconKind: "service" | "command" | null = null;
        if (showScriptsIcon) {
          scriptIconKind = hasRunningService ? "service" : "command";
        }
        const workspaceRowStyle = getWorkspaceRowStyle({ isDragging, selected, isHovered });
        return (
          <View
            {...(draggable ? dragAttributes : {})}
            {...(draggable ? dragHandleProps?.listeners : {})}
            ref={
              draggable ? (dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>) : undefined
            }
            style={styles.workspaceRowContainer}
            {...hoverHandlers}
          >
            <Pressable
              disabled={isArchiving}
              aria-selected={selected}
              accessibilityRole="button"
              accessibilityState={accessibilityState}
              style={workspaceRowStyle}
              onPressIn={draggable ? interaction.handlePressIn : undefined}
              onTouchMove={draggable ? interaction.handleTouchMove : undefined}
              onPressOut={draggable ? interaction.handlePressOut : undefined}
              onPress={handlePress}
              testID={`sidebar-workspace-row-${workspace.workspaceKey}`}
            >
              <SidebarWorkspaceRowContent
                workspace={workspace}
                subtitle={subtitle}
                scriptIconKind={scriptIconKind}
                isHovered={isHovered}
                isLoading={isArchiving || isCreating}
                isCreating={isCreating}
                shortcutNumber={shortcutNumber}
                showShortcutBadge={showShortcutBadge}
              >
                <WorkspaceRowTrailingActions
                  workspace={workspace}
                  isHovered={isHovered}
                  isTouchPlatform={isTouchPlatform}
                  isCreating={isCreating}
                  showShortcutBadge={showShortcutBadge}
                  shortcutNumber={shortcutNumber}
                  archiveLabel={archiveLabel}
                  archiveStatus={archiveStatus}
                  archivePendingLabel={archivePendingLabel}
                  archiveShortcutKeys={archiveShortcutKeys}
                  onArchive={onArchive}
                  onCopyBranchName={onCopyBranchName}
                  onCopyPath={onCopyPath}
                  onRename={onRename}
                  onMarkAsRead={onMarkAsRead}
                />
              </SidebarWorkspaceRowContent>
            </Pressable>
          </View>
        );
      }}
    </SidebarWorkspaceRowFrame>
  );
}

function WorkspaceRowTrailingActions({
  workspace,
  isHovered,
  isTouchPlatform,
  isCreating,
  showShortcutBadge,
  shortcutNumber,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
  onArchive,
  onMarkAsRead,
  onCopyBranchName,
  onCopyPath,
  onRename,
}: {
  workspace: SidebarWorkspaceEntry;
  isHovered: boolean;
  isTouchPlatform: boolean;
  isCreating: boolean;
  showShortcutBadge: boolean;
  shortcutNumber: number | null;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  onArchive?: () => void;
  onMarkAsRead?: () => void;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  onRename?: () => void;
}) {
  const { t } = useTranslation();
  const showShortcut = showShortcutBadge && shortcutNumber !== null;
  const showKebab = Boolean(onArchive && (isHovered || isTouchPlatform));
  const showKebabInSlot = showKebab && !showShortcut;
  const shouldRenderActionSlot = Boolean(onArchive || workspace.diffStat);

  return (
    <>
      {isCreating ? (
        <Text style={styles.workspaceCreatingText}>{t("sidebar.workspace.status.creating")}</Text>
      ) : null}
      {shouldRenderActionSlot ? (
        <SidebarWorkspaceTrailingActionSlot>
          <SidebarWorkspaceTrailingActionBase
            visible={Boolean(workspace.diffStat && !showKebabInSlot && !showShortcut)}
          >
            {workspace.diffStat ? (
              <DiffStat
                additions={workspace.diffStat.additions}
                deletions={workspace.diffStat.deletions}
              />
            ) : null}
          </SidebarWorkspaceTrailingActionBase>
          <SidebarWorkspaceTrailingActionOverlay visible={showKebabInSlot}>
            {onArchive ? (
              <SidebarWorkspaceMenu
                workspaceKey={workspace.workspaceKey}
                onCopyPath={onCopyPath}
                onCopyBranchName={onCopyBranchName}
                onRename={onRename}
                onMarkAsRead={onMarkAsRead}
                onArchive={onArchive}
                archiveLabel={archiveLabel}
                archiveStatus={archiveStatus}
                archivePendingLabel={archivePendingLabel}
                archiveShortcutKeys={archiveShortcutKeys}
              />
            ) : null}
          </SidebarWorkspaceTrailingActionOverlay>
        </SidebarWorkspaceTrailingActionSlot>
      ) : null}
    </>
  );
}

function getWorkspaceRowStyle({
  isDragging,
  selected,
  isHovered,
}: {
  isDragging: boolean;
  selected: boolean;
  isHovered: boolean;
}) {
  return [
    styles.workspaceRow,
    isDragging && styles.workspaceRowDragging,
    selected && styles.sidebarRowSelected,
    isHovered && styles.workspaceRowHovered,
  ];
}

export const MemoSidebarWorkspaceRow = memo(SidebarWorkspaceRow);

const styles = StyleSheet.create((theme) => ({
  workspaceRowContainer: {
    position: "relative",
  },
  workspaceRow: {
    minHeight: 36,
    marginBottom: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "center",
    gap: theme.spacing[1],
    userSelect: "none",
  },
  workspaceRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  workspaceRowDragging: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    transform: [{ scale: 1.02 }],
    zIndex: 3,
    ...theme.shadow.md,
  },
  sidebarRowSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  workspaceCreatingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flexShrink: 0,
  },
}));
