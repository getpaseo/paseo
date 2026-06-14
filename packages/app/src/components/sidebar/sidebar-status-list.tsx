import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View, Text, Pressable, ScrollView, type PressableStateCallbackType } from "react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  buildStatusGroups,
  buildStatusShortcutIndex,
  type StatusGroup,
} from "@/hooks/sidebar-status-view-model";
import { isWeb as platformIsWeb, isNative as platformIsNative } from "@/constants/platform";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { withUnistyles } from "react-native-unistyles";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
  MoreVertical,
  Copy,
  Archive,
  Pencil,
} from "lucide-react-native";
import { DiffStat } from "@/components/diff-stat";
import { useSidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { slugify, validateBranchSlug, MAX_SLUG_LENGTH } from "@getpaseo/protocol/branch-slug";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { requireWorkspaceDirectory, resolveWorkspaceDirectory } from "@/utils/workspace-directory";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { archiveWorkspaceOptimistically } from "@/workspace/workspace-archive";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import { confirmRiskyWorktreeArchive } from "@/git/worktree-archive-warning";
import { confirmDialog } from "@/utils/confirm-dialog";
import * as Clipboard from "expo-clipboard";
import { Shortcut } from "@/components/ui/shortcut";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useClearWorkspaceAttention } from "@/hooks/use-clear-workspace-attention";
import {
  SidebarWorkspaceRowFrame,
  SidebarWorkspaceRowContent,
  SidebarWorkspaceTrailingActionBase,
  SidebarWorkspaceTrailingActionOverlay,
  SidebarWorkspaceTrailingActionSlot,
} from "@/components/sidebar/sidebar-workspace-row-content";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";

// Themed icon wrappers
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const blueColorMapping = (theme: Theme) => ({ color: theme.colors.palette.blue[500] });
const amberColorMapping = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });
const redColorMapping = (theme: Theme) => ({ color: theme.colors.palette.red[500] });
const greenColorMapping = (theme: Theme) => ({ color: theme.colors.palette.green[500] });

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleX = withUnistyles(CircleX);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedCopy = withUnistyles(Copy);
const ThemedArchive = withUnistyles(Archive);
const ThemedPencil = withUnistyles(Pencil);

const copyLeadingIcon = <ThemedCopy size={14} uniProps={foregroundMutedColorMapping} />;
const markAsReadLeadingIcon = (
  <ThemedCircleCheck size={14} uniProps={foregroundMutedColorMapping} />
);
const archiveLeadingIcon = <ThemedArchive size={14} uniProps={foregroundMutedColorMapping} />;
const renameLeadingIcon = <ThemedPencil size={14} uniProps={foregroundMutedColorMapping} />;

interface StatusWorkspaceListProps {
  workspaces: SidebarWorkspaceEntry[];
  projectNamesByKey: Map<string, string>;
  serverId: string | null;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
}

export function SidebarStatusWorkspaceList({
  workspaces,
  projectNamesByKey,
  serverId,
  shortcutIndexByWorkspaceKey: _projectShortcutIndex,
  showShortcutBadges,
  onWorkspacePress,
}: StatusWorkspaceListProps) {
  const groups = useMemo(
    () => buildStatusGroups(workspaces, projectNamesByKey),
    [workspaces, projectNamesByKey],
  );
  const collapsedStatusGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedStatusGroupKeys,
  );

  const statusShortcutIndex = useMemo(
    () =>
      showShortcutBadges
        ? buildStatusShortcutIndex(
            groups.filter((group) => !collapsedStatusGroupKeys.has(group.bucket)),
          )
        : new Map<string, number>(),
    [collapsedStatusGroupKeys, groups, showShortcutBadges],
  );

  return (
    <View style={styles.container}>
      {platformIsNative ? (
        <NestableScrollContainer
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-status-list-scroll"
        >
          <StatusGroupList
            groups={groups}
            collapsedStatusGroupKeys={collapsedStatusGroupKeys}
            projectNamesByKey={projectNamesByKey}
            serverId={serverId}
            shortcutIndex={statusShortcutIndex}
            showShortcutBadges={showShortcutBadges}
            onWorkspacePress={onWorkspacePress}
          />
        </NestableScrollContainer>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-status-list-scroll"
        >
          <StatusGroupList
            groups={groups}
            collapsedStatusGroupKeys={collapsedStatusGroupKeys}
            projectNamesByKey={projectNamesByKey}
            serverId={serverId}
            shortcutIndex={statusShortcutIndex}
            showShortcutBadges={showShortcutBadges}
            onWorkspacePress={onWorkspacePress}
          />
        </ScrollView>
      )}
    </View>
  );
}

function StatusGroupList({
  groups,
  collapsedStatusGroupKeys,
  projectNamesByKey,
  serverId,
  shortcutIndex,
  showShortcutBadges,
  onWorkspacePress,
}: {
  groups: StatusGroup[];
  collapsedStatusGroupKeys: ReadonlySet<string>;
  projectNamesByKey: Map<string, string>;
  serverId: string | null;
  shortcutIndex: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
}) {
  return (
    <>
      {groups.map((group) => (
        <View key={group.bucket} style={styles.statusGroupBlock}>
          <StatusGroupHeader group={group} collapsed={collapsedStatusGroupKeys.has(group.bucket)} />
          {!collapsedStatusGroupKeys.has(group.bucket) ? (
            <View style={styles.statusWorkspaceListContainer}>
              {group.rows.map((workspace) => (
                <StatusWorkspaceRow
                  key={workspace.workspaceKey}
                  workspace={workspace}
                  projectName={projectNamesByKey.get(workspace.projectKey) ?? ""}
                  serverId={serverId}
                  shortcutNumber={shortcutIndex.get(workspace.workspaceKey) ?? null}
                  showShortcutBadge={showShortcutBadges}
                  onWorkspacePress={onWorkspacePress}
                />
              ))}
            </View>
          ) : null}
        </View>
      ))}
    </>
  );
}

function StatusGroupHeader({ group, collapsed }: { group: StatusGroup; collapsed: boolean }) {
  const [isHovered, setIsHovered] = useState(false);
  const toggleStatusGroupCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleStatusGroupCollapsed,
  );
  const handlePress = useCallback(() => {
    toggleStatusGroupCollapsed(group.bucket);
  }, [group.bucket, toggleStatusGroupCollapsed]);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.statusGroupRow,
      isHovered && styles.statusGroupRowHovered,
      pressed && styles.statusGroupRowPressed,
    ],
    [isHovered],
  );
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);

  return (
    <View onPointerEnter={handleHoverIn} onPointerLeave={handleHoverOut}>
      <Pressable
        accessibilityRole={platformIsWeb ? undefined : "button"}
        accessibilityLabel={`${group.label} status group`}
        accessibilityState={accessibilityState}
        style={rowStyle}
        onPress={handlePress}
        testID={`sidebar-status-group-${group.bucket}`}
      >
        <View style={styles.statusGroupRowLeft}>
          <View style={styles.statusGroupLeadingVisualSlot}>
            <StatusGroupLeadingVisual
              bucket={group.bucket}
              collapsed={collapsed}
              showChevron={isHovered}
            />
          </View>
          <View style={styles.statusGroupTitleGroup}>
            <Text style={styles.statusGroupTitle} numberOfLines={1}>
              {group.label}
            </Text>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

function StatusGroupLeadingVisual({
  bucket,
  collapsed,
  showChevron,
}: {
  bucket: StatusGroup["bucket"];
  collapsed: boolean;
  showChevron: boolean;
}) {
  if (!showChevron) {
    return <StatusGroupIcon bucket={bucket} />;
  }
  if (collapsed) {
    return <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} />;
  }
  return <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />;
}

function StatusGroupIcon({ bucket }: { bucket: StatusGroup["bucket"] }) {
  switch (bucket) {
    case "needs_input":
      return <ThemedCircleAlert size={14} uniProps={amberColorMapping} />;
    case "failed":
      return <ThemedCircleX size={14} uniProps={redColorMapping} />;
    case "attention":
      return <ThemedCircleCheck size={14} uniProps={greenColorMapping} />;
    case "running":
      return <ThemedCircleDot size={14} uniProps={blueColorMapping} />;
    case "done":
      return <ThemedCircleCheck size={14} uniProps={foregroundMutedColorMapping} />;
  }
}

const StatusWorkspaceRow = memo(function StatusWorkspaceRow({
  workspace,
  projectName,
  serverId,
  shortcutNumber,
  showShortcutBadge,
  onWorkspacePress,
}: {
  workspace: SidebarWorkspaceEntry;
  projectName: string;
  serverId: string | null;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onWorkspacePress?: () => void;
}) {
  const hydratedWorkspace = useSidebarWorkspaceEntry(serverId, workspace.workspaceId);
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const selected =
    activeWorkspaceSelection?.serverId === workspace.serverId &&
    activeWorkspaceSelection?.workspaceId === workspace.workspaceId;

  const handlePress = useCallback(() => {
    if (!serverId) return;
    onWorkspacePress?.();
    navigateToWorkspace(serverId, workspace.workspaceId);
  }, [serverId, onWorkspacePress, workspace.workspaceId]);

  if (!hydratedWorkspace) return null;

  return (
    <StatusWorkspaceRowWithMenu
      workspace={hydratedWorkspace}
      projectName={projectName}
      selected={selected}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      onPress={handlePress}
    />
  );
});

function StatusWorkspaceRowWithMenu({
  workspace,
  projectName,
  selected,
  shortcutNumber,
  showShortcutBadge,
  onPress,
}: {
  workspace: SidebarWorkspaceEntry;
  projectName: string;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const archiveWorktree = useCheckoutGitActionsStore((state) => state.archiveWorktree);
  const queryClient = useQueryClient();
  const [isArchivingWorkspace, setIsArchivingWorkspace] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const workspaceDirectory = resolveWorkspaceDirectory({
    workspaceDirectory: workspace.workspaceDirectory,
  });
  const archiveStatus = useCheckoutGitActionsStore((state) =>
    workspaceDirectory
      ? state.getStatus({
          serverId: workspace.serverId,
          cwd: workspaceDirectory,
          actionId: "archive-worktree",
        })
      : "idle",
  );
  const isWorktree = workspace.workspaceKind === "worktree";
  const isArchiving = isWorktree ? workspace.archivingAt !== null : isArchivingWorkspace;

  const redirectAfterArchive = useCallback(() => {
    redirectIfArchivingActiveWorkspace({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
      activeWorkspaceSelection: selected
        ? { serverId: workspace.serverId, workspaceId: workspace.workspaceId }
        : null,
    });
  }, [selected, workspace]);

  const archiveWorktreeAfterConfirmation = useCallback(async () => {
    if (isArchiving) return;
    const confirmed = await confirmRiskyWorktreeArchive({
      worktreeName: workspace.name,
      isDirty: workspace.archiveHasUncommittedChanges,
      aheadOfOrigin: workspace.archiveUnpushedCommitCount,
      diffStat: workspace.diffStat,
    });
    if (!confirmed) return;
    let archiveDirectory: string;
    try {
      archiveDirectory = requireWorkspaceDirectory({
        workspaceId: workspace.workspaceId,
        workspaceDirectory: workspace.workspaceDirectory,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Workspace path not available");
      return;
    }
    redirectAfterArchive();
    void archiveWorktree({
      serverId: workspace.serverId,
      cwd: archiveDirectory,
      worktreePath: archiveDirectory,
    }).catch((error) => {
      toast.error(error instanceof Error ? error.message : "Failed to archive worktree");
    });
  }, [archiveWorktree, isArchiving, redirectAfterArchive, toast, workspace]);

  const hideWorkspaceAfterConfirmation = useCallback(async () => {
    if (isArchivingWorkspace) return;
    const confirmed = await confirmDialog({
      title: "Hide workspace?",
      message: `Hide "${workspace.name}" from the sidebar?\n\nFiles on disk will not be changed.`,
      confirmLabel: "Hide",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!confirmed) return;
    const client = getHostRuntimeStore().getClient(workspace.serverId);
    if (!client) {
      toast.error(t("workspace.terminal.hostDisconnected"));
      return;
    }
    setIsArchivingWorkspace(true);
    try {
      await archiveWorkspaceOptimistically({
        client,
        workspace,
        afterHide: redirectAfterArchive,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to hide workspace");
    } finally {
      setIsArchivingWorkspace(false);
    }
  }, [isArchivingWorkspace, redirectAfterArchive, t, toast, workspace]);

  const handleCopyPath = useCallback(() => {
    let copyTargetDirectory: string;
    try {
      copyTargetDirectory = requireWorkspaceDirectory({
        workspaceId: workspace.workspaceId,
        workspaceDirectory: workspace.workspaceDirectory,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Workspace path not available");
      return;
    }
    void Clipboard.setStringAsync(copyTargetDirectory);
    toast.copied("Path copied");
  }, [toast, workspace.workspaceDirectory, workspace.workspaceId]);

  const handleCopyBranchName = useCallback(() => {
    void Clipboard.setStringAsync(workspace.name);
    toast.copied("Branch name copied");
  }, [toast, workspace.name]);

  const renameMutation = useMutation({
    mutationFn: async (branch: string) => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const targetCwd = requireWorkspaceDirectory({
        workspaceId: workspace.workspaceId,
        workspaceDirectory: workspace.workspaceDirectory,
      });
      const payload = await client.renameBranch({ cwd: targetCwd, branch });
      if (!payload.success || payload.error) {
        throw new Error(payload.error?.message ?? "Failed to rename branch");
      }
      return { targetCwd };
    },
    onSuccess: async ({ targetCwd }) => {
      await invalidateCheckoutGitQueriesForClient(queryClient, {
        serverId: workspace.serverId,
        cwd: targetCwd,
      });
    },
  });

  const handleOpenRename = useCallback(() => setIsRenameOpen(true), []);
  const handleCloseRename = useCallback(() => setIsRenameOpen(false), []);
  const handleSubmitRename = useCallback(
    async (value: string) => {
      await renameMutation.mutateAsync(slugify(value));
    },
    [renameMutation],
  );
  const validateRenameSlug = useCallback((value: string): string | null => {
    const result = validateBranchSlug(slugify(value));
    if (result.valid) return null;
    return result.error ?? "Invalid branch name";
  }, []);

  const archiveShortcutKeys = useShortcutKeys("archive-worktree");
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
    handlerId: `worktree-archive-${workspace.workspaceKey}`,
    actions: ["worktree.archive"],
    enabled: selected && !isArchiving,
    priority: 0,
    handle: () => {
      if (isWorktree) {
        void archiveWorktreeAfterConfirmation();
      } else {
        void hideWorkspaceAfterConfirmation();
      }
      return true;
    },
  });

  let computedArchiveStatus: "idle" | "pending" | "success" = "idle";
  if (isWorktree) {
    computedArchiveStatus = archiveStatus;
  } else if (isArchivingWorkspace) {
    computedArchiveStatus = "pending";
  }

  return (
    <>
      <StatusWorkspaceRowInner
        workspace={workspace}
        projectName={projectName}
        selected={selected}
        shortcutNumber={shortcutNumber}
        showShortcutBadge={showShortcutBadge}
        onPress={onPress}
        isArchiving={isArchiving}
        archiveLabel={isWorktree ? "Archive worktree" : "Hide from sidebar"}
        archiveStatus={computedArchiveStatus}
        archivePendingLabel={isWorktree ? "Archiving..." : "Hiding..."}
        onArchive={isWorktree ? archiveWorktreeAfterConfirmation : hideWorkspaceAfterConfirmation}
        onCopyBranchName={workspace.projectKind === "git" ? handleCopyBranchName : undefined}
        onCopyPath={handleCopyPath}
        onRename={workspace.projectKind === "git" ? handleOpenRename : undefined}
        onMarkAsRead={hasClearableAttention ? handleMarkAsRead : undefined}
        archiveShortcutKeys={selected ? archiveShortcutKeys : null}
      />
      <AdaptiveRenameModal
        visible={isRenameOpen}
        title="Rename workspace"
        initialValue={workspace.name}
        placeholder="branch-name"
        submitLabel="Rename"
        validate={validateRenameSlug}
        maxLength={MAX_SLUG_LENGTH}
        onClose={handleCloseRename}
        onSubmit={handleSubmitRename}
        testID={`sidebar-workspace-rename-modal-${workspace.workspaceKey}`}
      />
    </>
  );
}

function StatusWorkspaceRowInner({
  workspace,
  projectName,
  selected,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  isArchiving,
  archiveLabel,
  archiveStatus = "idle",
  archivePendingLabel,
  onArchive,
  onCopyBranchName,
  onCopyPath,
  onRename,
  onMarkAsRead,
  archiveShortcutKeys,
}: {
  workspace: SidebarWorkspaceEntry;
  projectName: string;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
  isArchiving: boolean;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  onArchive?: () => void;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  onRename?: () => void;
  onMarkAsRead?: () => void;
  archiveShortcutKeys?: ShortcutKey[][] | null;
}) {
  const isTouchPlatform = platformIsNative;

  const isDesktop = !isTouchPlatform;
  const showScriptsIcon = isDesktop && workspace.hasRunningScripts;
  const hasRunningService = workspace.scripts.some(
    (s) => s.lifecycle === "running" && (s.type ?? "service") === "service",
  );
  let scriptIconKind: "service" | "command" | null = null;
  if (showScriptsIcon) {
    scriptIconKind = hasRunningService ? "service" : "command";
  }

  const accessibilityState = useMemo(() => ({ selected }), [selected]);

  return (
    <SidebarWorkspaceRowFrame workspace={workspace}>
      {({ isHovered, hoverHandlers }) => {
        const showShortcut = showShortcutBadge && shortcutNumber !== null;
        const showKebab = Boolean(onArchive && (isHovered || isTouchPlatform));
        const showKebabInSlot = showKebab && !showShortcut;
        const shouldRenderActionSlot = Boolean(onArchive || workspace.diffStat);
        const workspaceRowStyle = getStatusWorkspaceRowStyle({ selected, isHovered });
        return (
          <View style={styles.workspaceRowContainer} {...hoverHandlers}>
            <Pressable
              disabled={isArchiving}
              accessibilityRole="button"
              accessibilityState={accessibilityState}
              style={workspaceRowStyle}
              onPress={onPress}
              testID={`sidebar-workspace-row-${workspace.workspaceKey}`}
            >
              <SidebarWorkspaceRowContent
                workspace={workspace}
                subtitle={projectName}
                scriptIconKind={scriptIconKind}
                isHovered={isHovered}
                isLoading={isArchiving}
                shortcutNumber={shortcutNumber}
                showShortcutBadge={showShortcutBadge}
              >
                {shouldRenderActionSlot ? (
                  <StatusWorkspaceActionSlot
                    workspace={workspace}
                    showBase={Boolean(workspace.diffStat && !showKebabInSlot && !showShortcut)}
                    showOverlay={showKebabInSlot}
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
              </SidebarWorkspaceRowContent>
            </Pressable>
          </View>
        );
      }}
    </SidebarWorkspaceRowFrame>
  );
}

function StatusWorkspaceActionSlot({
  workspace,
  showBase,
  showOverlay,
  onCopyPath,
  onCopyBranchName,
  onRename,
  onMarkAsRead,
  onArchive,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
}: {
  workspace: SidebarWorkspaceEntry;
  showBase: boolean;
  showOverlay: boolean;
  onCopyPath?: () => void;
  onCopyBranchName?: () => void;
  onRename?: () => void;
  onMarkAsRead?: () => void;
  onArchive?: () => void;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  archiveShortcutKeys?: ShortcutKey[][] | null;
}) {
  return (
    <SidebarWorkspaceTrailingActionSlot>
      <SidebarWorkspaceTrailingActionBase visible={showBase}>
        {workspace.diffStat ? (
          <DiffStat
            additions={workspace.diffStat.additions}
            deletions={workspace.diffStat.deletions}
          />
        ) : null}
      </SidebarWorkspaceTrailingActionBase>
      <SidebarWorkspaceTrailingActionOverlay visible={showOverlay}>
        {onArchive ? (
          <StatusKebabMenu
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
  );
}

function StatusKebabMenu({
  workspaceKey,
  onCopyPath,
  onCopyBranchName,
  onRename,
  onMarkAsRead,
  onArchive,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
}: {
  workspaceKey: string;
  onCopyPath?: () => void;
  onCopyBranchName?: () => void;
  onRename?: () => void;
  onMarkAsRead?: () => void;
  onArchive: () => void;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  archiveShortcutKeys?: ShortcutKey[][] | null;
}) {
  const archiveTrailing = useMemo(
    () => (archiveShortcutKeys ? <Shortcut chord={archiveShortcutKeys} /> : null),
    [archiveShortcutKeys],
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={kebabStyle}
        accessibilityRole={platformIsWeb ? undefined : "button"}
        accessibilityLabel="Workspace actions"
        testID={`sidebar-workspace-kebab-${workspaceKey}`}
      >
        {({ hovered }: { hovered?: boolean }) => (
          <ThemedMoreVertical
            size={14}
            uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={260}>
        {onCopyPath ? (
          <DropdownMenuItem
            testID={`sidebar-workspace-menu-copy-path-${workspaceKey}`}
            leading={copyLeadingIcon}
            onSelect={onCopyPath}
          >
            Copy path
          </DropdownMenuItem>
        ) : null}
        {onCopyBranchName ? (
          <DropdownMenuItem
            testID={`sidebar-workspace-menu-copy-branch-name-${workspaceKey}`}
            leading={copyLeadingIcon}
            onSelect={onCopyBranchName}
          >
            Copy branch name
          </DropdownMenuItem>
        ) : null}
        {onRename ? (
          <DropdownMenuItem
            testID={`sidebar-workspace-menu-rename-${workspaceKey}`}
            leading={renameLeadingIcon}
            onSelect={onRename}
          >
            Rename workspace
          </DropdownMenuItem>
        ) : null}
        {onMarkAsRead ? (
          <DropdownMenuItem
            testID={`sidebar-workspace-menu-mark-as-read-${workspaceKey}`}
            leading={markAsReadLeadingIcon}
            onSelect={onMarkAsRead}
          >
            Mark as read
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          testID={`sidebar-workspace-menu-archive-${workspaceKey}`}
          leading={archiveLeadingIcon}
          trailing={archiveTrailing}
          status={archiveStatus}
          pendingLabel={archivePendingLabel}
          onSelect={onArchive}
        >
          {archiveLabel ?? "Archive"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function kebabStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabButton, hovered && styles.kebabButtonHovered];
}

function getStatusWorkspaceRowStyle({
  selected,
  isHovered,
}: {
  selected: boolean;
  isHovered: boolean;
}) {
  return [
    styles.workspaceRow,
    selected && styles.sidebarRowSelected,
    isHovered && styles.workspaceRowHovered,
  ];
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  statusGroupBlock: {
    marginBottom: theme.spacing[1],
  },
  statusWorkspaceListContainer: {},
  statusGroupRow: {
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  statusGroupRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  statusGroupRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  statusGroupRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  statusGroupLeadingVisualSlot: {
    position: "relative",
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  statusGroupTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  statusGroupTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "400",
    minWidth: 0,
    flexShrink: 1,
  },
  workspaceRowContainer: {
    position: "relative",
  },
  workspaceRow: {
    minHeight: 36,
    marginBottom: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[3] + theme.spacing[3],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "flex-start",
    gap: theme.spacing[1],
    userSelect: "none",
  },
  workspaceRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  workspaceRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  sidebarRowSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  kebabButton: {
    padding: 2,
    borderRadius: 4,
    marginLeft: 2,
  },
  kebabButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
