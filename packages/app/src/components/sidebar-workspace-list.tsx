import {
  View,
  Text,
  Pressable,
  Image,
  Platform,
  ActivityIndicator,
  StatusBar,
  ScrollView,
  type GestureResponderEvent,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useMutation, useQueries } from "@tanstack/react-query";
import {
  useCallback,
  useMemo,
  useState,
  useEffect,
  useRef,
  type ReactElement,
  type MutableRefObject,
} from "react";
import { router, usePathname } from "expo-router";
import { navigateToWorkspace } from "@/hooks/use-workspace-navigation";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { type GestureType } from "react-native-gesture-handler";
import * as Clipboard from "expo-clipboard";
import {
  Archive,
  CircleAlert,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderPlus,
  FolderGit2,
  GitPullRequest,
  Monitor,
  MoreVertical,
  Plus,
  Trash2,
} from "lucide-react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import { DraggableList, type DraggableRenderItemInfo } from "./draggable-list";
import type { DraggableListDragHandleProps } from "./draggable-list.types";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { getIsElectronRuntime, isCompactFormFactor } from "@/constants/layout";
import { projectIconQueryKey } from "@/hooks/use-project-icon-query";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";
import {
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { ContextMenuTrigger, useContextMenu } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { SyncedLoader } from "@/components/synced-loader";
import { useToast } from "@/contexts/toast-context";
import { useCheckoutGitActionsStore } from "@/stores/checkout-git-actions-store";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";
import { decideLongPressMove } from "@/utils/sidebar-gesture-arbitration";
import { confirmDialog } from "@/utils/confirm-dialog";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";
import { getStatusDotColor, isEmphasizedStatusDotBucket } from "@/utils/status-dot-color";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { type PrHint, useWorkspacePrHint } from "@/hooks/use-checkout-pr-status-query";
import { buildSidebarProjectRowModel } from "@/utils/sidebar-project-row-model";
import { useNavigationActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { createNameId } from "mnemonic-id";
import { buildWorkspaceArchiveRedirectRoute } from "@/utils/workspace-archive-navigation";
import { openExternalUrl } from "@/utils/open-external-url";

function toProjectIconDataUri(icon: { mimeType: string; data: string } | null): string | null {
  if (!icon) {
    return null;
  }
  return `data:${icon.mimeType};base64,${icon.data}`;
}

const workspaceKeyExtractor = (workspace: SidebarWorkspaceEntry) => workspace.workspaceKey;

const projectKeyExtractor = (project: SidebarProjectEntry) => project.projectKey;
const EMPTY_WORKSPACES = new Map();
const WORKSPACE_STATUS_DOT_WIDTH = 14;
const DEFAULT_STATUS_DOT_SIZE = 7;
const EMPHASIZED_STATUS_DOT_SIZE = 9;
const DEFAULT_STATUS_DOT_OFFSET = 0;
const EMPHASIZED_STATUS_DOT_OFFSET = -1;
function getWorkspacePrIconColor(theme: ReturnType<typeof useUnistyles>["theme"], state: PrHint["state"]) {
  switch (state) {
    case "merged":
      return theme.colors.palette.purple[500];
    case "open":
      return theme.colors.palette.green[500];
    case "closed":
      return theme.colors.palette.red[500];
  }
}

interface SidebarWorkspaceListProps {
  projects: SidebarProjectEntry[];
  serverId: string | null;
  collapsedProjectKeys: ReadonlySet<string>;
  onToggleProjectCollapsed: (projectKey: string) => void;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  onWorkspacePress?: () => void;
  onAddProject?: () => void;
  listFooterComponent?: ReactElement | null;
  /** Gesture ref for coordinating with parent gestures (e.g., sidebar close) */
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
}

interface ProjectHeaderRowProps {
  project: SidebarProjectEntry;
  displayName: string;
  iconDataUri: string | null;
  workspace: SidebarWorkspaceEntry | null;
  selected?: boolean;
  chevron: "expand" | "collapse" | null;
  onPress: () => void;
  serverId: string | null;
  canCreateWorktree: boolean;
  isProjectActive?: boolean;
  onWorkspacePress?: () => void;
  onWorktreeCreated?: (workspaceId: string) => void;
  shortcutNumber?: number | null;
  showShortcutBadge?: boolean;
  drag: () => void;
  isDragging: boolean;
  isArchiving?: boolean;
  menuController: ReturnType<typeof useContextMenu> | null;
  onRemoveProject?: () => void;
  removeProjectStatus?: "idle" | "pending";
  dragHandleProps?: DraggableListDragHandleProps;
}

interface WorkspaceRowInnerProps {
  workspace: SidebarWorkspaceEntry;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
  drag: () => void;
  isDragging: boolean;
  isArchiving: boolean;
  isCreating?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  menuController: ReturnType<typeof useContextMenu> | null;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  onArchive?: () => void;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  archiveShortcutKeys?: ShortcutKey[][] | null;
}

function WorkspacePrBadge({ hint }: { hint: PrHint }) {
  const { theme } = useUnistyles();
  const [isHovered, setIsHovered] = useState(false);
  const textColor = isHovered ? theme.colors.foreground : theme.colors.foregroundMuted;
  const iconColor = getWorkspacePrIconColor(theme, hint.state);

  const handlePressIn = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void openExternalUrl(hint.url);
    },
    [hint.url],
  );

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${hint.state} pull request #${hint.number}`}
      hitSlop={4}
      onPressIn={handlePressIn}
      onPress={handlePress}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      style={({ pressed }) => [
        styles.workspacePrBadge,
        pressed && styles.workspacePrBadgePressed,
      ]}
    >
      <GitPullRequest size={12} color={iconColor} />
      <Text
        style={[
          styles.workspacePrBadgeText,
          { color: textColor },
        ]}
        numberOfLines={1}
      >
        #{hint.number}
      </Text>
      {isHovered && <ExternalLink size={10} color={textColor} />}
    </Pressable>
  );
}

function WorkspaceStatusIndicator({
  bucket,
  workspaceKind,
  loading = false,
}: {
  bucket: SidebarWorkspaceEntry["statusBucket"];
  workspaceKind: SidebarWorkspaceEntry["workspaceKind"];
  loading?: boolean;
}) {
  const { theme } = useUnistyles();
  const shouldShowSyncedLoader = shouldRenderSyncedStatusLoader({ bucket });

  if (loading) {
    return (
      <View style={styles.workspaceStatusDot}>
        <ActivityIndicator size={8} color={theme.colors.foregroundMuted} />
      </View>
    );
  }

  if (shouldShowSyncedLoader) {
    return (
      <View style={styles.workspaceStatusDot}>
        <SyncedLoader size={11} color={theme.colors.palette.amber[500]} />
      </View>
    );
  }

  if (bucket === "needs_input") {
    return (
      <View style={styles.workspaceStatusDot}>
        <CircleAlert size={14} color={theme.colors.palette.amber[500]} />
      </View>
    );
  }

  const KindIcon =
    workspaceKind === "local_checkout"
      ? Monitor
      : workspaceKind === "worktree"
        ? FolderGit2
        : null;
  if (!KindIcon) return null;

  const dotColor = getStatusDotColor({ theme, bucket, showDoneAsInactive: false });
  const statusDotSize = isEmphasizedStatusDotBucket(bucket)
    ? EMPHASIZED_STATUS_DOT_SIZE
    : DEFAULT_STATUS_DOT_SIZE;
  const statusDotOffset =
    statusDotSize === EMPHASIZED_STATUS_DOT_SIZE
      ? EMPHASIZED_STATUS_DOT_OFFSET
      : DEFAULT_STATUS_DOT_OFFSET;

  return (
    <View style={styles.workspaceStatusDot}>
      <KindIcon size={14} color={theme.colors.foregroundMuted} />
      {dotColor ? (
        <View
          style={[
            styles.statusDotOverlay,
            {
              backgroundColor: dotColor,
              borderColor: theme.colors.surface0,
              width: statusDotSize,
              height: statusDotSize,
              right: statusDotOffset,
              bottom: statusDotOffset,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

function ProjectLeadingVisual({
  displayName,
  iconDataUri,
  workspace,
  chevron = null,
  showChevron = false,
  isArchiving = false,
}: {
  displayName: string;
  iconDataUri: string | null;
  workspace: SidebarWorkspaceEntry | null;
  chevron?: "expand" | "collapse" | null;
  showChevron?: boolean;
  isArchiving?: boolean;
}) {
  const { theme } = useUnistyles();
  const placeholderLabel = projectIconPlaceholderLabelFromDisplayName(displayName);
  const placeholderInitial = placeholderLabel.charAt(0).toUpperCase();
  const activeWorkspace = workspace;
  const shouldShowWorkspaceStatus =
    activeWorkspace !== null && (isArchiving || activeWorkspace.statusBucket !== "done");
  const shouldShowSyncedLoader = activeWorkspace
    ? shouldRenderSyncedStatusLoader({ bucket: activeWorkspace.statusBucket })
    : false;

  if (showChevron && chevron !== null) {
    return (
      <View style={styles.projectLeadingVisualSlot}>
        <ProjectInlineChevron chevron={chevron} />
      </View>
    );
  }

  const projectIcon = iconDataUri ? (
    <Image source={{ uri: iconDataUri }} style={styles.projectIcon} />
  ) : (
    <View style={styles.projectIconFallback}>
      <Text style={styles.projectIconFallbackText}>{placeholderInitial}</Text>
    </View>
  );

  if (!shouldShowWorkspaceStatus || !activeWorkspace) {
    return <View style={styles.projectLeadingVisualSlot}>{projectIcon}</View>;
  }

  if (isArchiving) {
    return (
      <View style={styles.projectLeadingVisualSlot}>
        <ActivityIndicator size={8} color={theme.colors.foregroundMuted} />
      </View>
    );
  }

  if (shouldShowSyncedLoader) {
    return (
      <View style={styles.projectLeadingVisualSlot}>
        <SyncedLoader size={11} color={theme.colors.palette.amber[500]} />
      </View>
    );
  }

  if (activeWorkspace.statusBucket === "needs_input") {
    return (
      <View style={styles.projectLeadingVisualSlot}>
        <CircleAlert size={14} color={theme.colors.palette.amber[500]} />
      </View>
    );
  }

  const dotColor = getStatusDotColor({
    theme,
    bucket: activeWorkspace.statusBucket,
    showDoneAsInactive: false,
  });
  const statusDotSize = isEmphasizedStatusDotBucket(activeWorkspace.statusBucket)
    ? EMPHASIZED_STATUS_DOT_SIZE
    : DEFAULT_STATUS_DOT_SIZE;
  const statusDotOffset =
    statusDotSize === EMPHASIZED_STATUS_DOT_SIZE
      ? EMPHASIZED_STATUS_DOT_OFFSET
      : DEFAULT_STATUS_DOT_OFFSET;

  return (
    <View style={styles.projectLeadingVisualSlot}>
      {projectIcon}
      {dotColor ? (
        <View
          style={[
            styles.statusDotOverlay,
            {
              backgroundColor: dotColor,
              borderColor: theme.colors.surface0,
              width: statusDotSize,
              height: statusDotSize,
              right: statusDotOffset,
              bottom: statusDotOffset,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

function ProjectInlineChevron({ chevron }: { chevron: "expand" | "collapse" | null }) {
  if (chevron === null) {
    return null;
  }
  if (chevron === "collapse") {
    return <ChevronDown size={14} color="#9ca3af" />;
  }
  return <ChevronRight size={14} color="#9ca3af" />;
}

function NewWorktreeButton({
  displayName,
  onPress,
  visible,
  loading = false,
  testID,
  showShortcutHint = false,
}: {
  displayName: string;
  onPress: () => void;
  visible: boolean;
  loading?: boolean;
  testID: string;
  showShortcutHint?: boolean;
}) {
  const { theme } = useUnistyles();
  const newWorktreeKeys = useShortcutKeys("new-worktree");

  return (
    <View style={styles.projectTrailingControlSlot} pointerEvents={visible ? "auto" : "none"}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild disabled={!visible}>
          <Pressable
            style={({ hovered, pressed }) => [
              styles.projectIconActionButton,
              !visible && styles.projectIconActionButtonHidden,
              (hovered || pressed) && !loading && styles.projectIconActionButtonHovered,
            ]}
            onPress={(event) => {
              event.stopPropagation();
              onPress();
            }}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel={`Create a new workspace for ${displayName}`}
            testID={testID}
          >
            {({ hovered, pressed }) =>
              loading ? (
                <ActivityIndicator size={14} color={theme.colors.foregroundMuted} />
              ) : (
                <FolderPlus
                  size={15}
                  color={
                    hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted
                  }
                />
              )
            }
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <View style={styles.projectActionTooltipRow}>
            <Text style={styles.projectActionTooltipText}>New workspace</Text>
            {showShortcutHint && newWorktreeKeys ? (
              <Shortcut chord={newWorktreeKeys} style={styles.projectActionTooltipShortcut} />
            ) : null}
          </View>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

function useLongPressDragInteraction(input: {
  drag: () => void;
  menuController: ReturnType<typeof useContextMenu> | null;
}) {
  const didLongPressRef = useRef(false);
  const dragArmedRef = useRef(false);
  const dragActivatedRef = useRef(false);
  const didStartDragRef = useRef(false);
  const scrollIntentRef = useRef(false);
  const menuOpenedRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchCurrentRef = useRef<{ x: number; y: number } | null>(null);
  const dragArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (dragArmTimerRef.current) {
      clearTimeout(dragArmTimerRef.current);
      dragArmTimerRef.current = null;
    }
    if (contextMenuTimerRef.current) {
      clearTimeout(contextMenuTimerRef.current);
      contextMenuTimerRef.current = null;
    }
  }, []);

  const openContextMenuAtStartPoint = useCallback(() => {
    if (!input.menuController || !touchStartRef.current) {
      return;
    }
    const statusBarHeight = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
    input.menuController.setAnchorRect({
      x: touchStartRef.current.x,
      y: touchStartRef.current.y + statusBarHeight,
      width: 0,
      height: 0,
    });
    input.menuController.setOpen(true);
    menuOpenedRef.current = true;
    didLongPressRef.current = true;
  }, [input.menuController]);

  const handleLongPress = useCallback(() => {
    // Manual timers own long-press behavior on mobile.
  }, []);

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  const armTimers = useCallback(() => {
    clearTimers();

    const DRAG_ARM_DELAY_MS = 180;
    const DRAG_ARM_STATIONARY_SLOP_PX = 4;
    const CONTEXT_MENU_DELAY_MS = 450;
    const CONTEXT_MENU_STATIONARY_SLOP_PX = 6;

    dragArmTimerRef.current = setTimeout(() => {
      if (scrollIntentRef.current || didStartDragRef.current || menuOpenedRef.current) {
        return;
      }
      const start = touchStartRef.current;
      const current = touchCurrentRef.current ?? start;
      if (!start || !current) {
        return;
      }
      const dx = current.x - start.x;
      const dy = current.y - start.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > DRAG_ARM_STATIONARY_SLOP_PX) {
        return;
      }
      dragArmedRef.current = true;
      dragActivatedRef.current = true;
      didLongPressRef.current = true;
      void Haptics.selectionAsync().catch(() => {});
      input.drag();
    }, DRAG_ARM_DELAY_MS);

    if (!input.menuController || Platform.OS === "web") {
      return;
    }

    contextMenuTimerRef.current = setTimeout(() => {
      if (scrollIntentRef.current || didStartDragRef.current || menuOpenedRef.current) {
        return;
      }
      const start = touchStartRef.current;
      const current = touchCurrentRef.current ?? start;
      if (!start || !current) {
        return;
      }
      const dx = current.x - start.x;
      const dy = current.y - start.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > CONTEXT_MENU_STATIONARY_SLOP_PX) {
        return;
      }
      void Haptics.selectionAsync().catch(() => {});
      openContextMenuAtStartPoint();
    }, CONTEXT_MENU_DELAY_MS);
  }, [clearTimers, input.menuController, openContextMenuAtStartPoint]);

  const handleDragIntent = useCallback(
    (details: { dx: number; dy: number; distance: number }) => {
      if (!dragActivatedRef.current) {
        return;
      }
      didStartDragRef.current = true;
      didLongPressRef.current = true;
      clearTimers();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    },
    [clearTimers],
  );

  const handleScrollIntent = useCallback(
    (details: { dx: number; dy: number; distance: number }) => {
      scrollIntentRef.current = true;
      didLongPressRef.current = true;
      clearTimers();
    },
    [clearTimers],
  );

  const handleSwipeIntent = useCallback(
    (details: { dx: number; dy: number; distance: number }) => {
      didLongPressRef.current = true;
      clearTimers();
    },
    [clearTimers],
  );

  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      didLongPressRef.current = false;
      dragArmedRef.current = false;
      dragActivatedRef.current = false;
      didStartDragRef.current = false;
      scrollIntentRef.current = false;
      menuOpenedRef.current = false;
      touchStartRef.current = {
        x: event.nativeEvent.pageX,
        y: event.nativeEvent.pageY,
      };
      touchCurrentRef.current = {
        x: event.nativeEvent.pageX,
        y: event.nativeEvent.pageY,
      };
      armTimers();
    },
    [armTimers],
  );

  const handleTouchMove = useCallback(
    (event: any) => {
      const start = touchStartRef.current;
      if (!start || didStartDragRef.current || menuOpenedRef.current) {
        return;
      }

      const touch = event?.nativeEvent?.touches?.[0] ?? event?.nativeEvent;
      const x = touch?.pageX;
      const y = touch?.pageY;
      if (typeof x !== "number" || typeof y !== "number") {
        return;
      }

      const current = { x, y };
      touchCurrentRef.current = current;
      const dx = current.x - start.x;
      const dy = current.y - start.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const decision = decideLongPressMove({
        dragArmed: dragArmedRef.current,
        didStartDrag: didStartDragRef.current,
        startPoint: start,
        currentPoint: current,
      });

      if (decision === "vertical_scroll") {
        handleScrollIntent({ dx, dy, distance });
        return;
      }

      if (decision === "horizontal_swipe" || decision === "cancel_long_press") {
        handleSwipeIntent({ dx, dy, distance });
        return;
      }

      if (decision === "start_drag") {
        handleDragIntent({ dx, dy, distance });
      }
    },
    [handleDragIntent, handleScrollIntent, handleSwipeIntent],
  );

  const handlePressOut = useCallback(() => {
    clearTimers();
    dragArmedRef.current = false;
    dragActivatedRef.current = false;
    touchStartRef.current = null;
    touchCurrentRef.current = null;
  }, [clearTimers]);

  return {
    didLongPressRef,
    handleLongPress,
    handlePressIn,
    handleTouchMove,
    handlePressOut,
  };
}

function ProjectHeaderRow({
  project,
  displayName,
  iconDataUri,
  workspace,
  selected = false,
  chevron,
  onPress,
  serverId,
  canCreateWorktree,
  isProjectActive = false,
  onWorkspacePress,
  onWorktreeCreated,
  shortcutNumber = null,
  showShortcutBadge = false,
  drag,
  isDragging,
  isArchiving = false,
  menuController,
  onRemoveProject,
  removeProjectStatus = "idle",
  dragHandleProps,
}: ProjectHeaderRowProps) {
  const { theme } = useUnistyles();
  const [isHovered, setIsHovered] = useState(false);
  const isMobileBreakpoint = isCompactFormFactor();
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const toast = useToast();

  const createWorktreeMutation = useMutation({
    mutationFn: async () => {
      if (!serverId) {
        throw new Error("No server");
      }
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client || !isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(serverId))) {
        throw new Error("Host is not connected");
      }
      const payload = await client.createPaseoWorktree({
        cwd: project.iconWorkingDir,
        worktreeSlug: createNameId(),
      });
      if (payload.error || !payload.workspace) {
        throw new Error(payload.error ?? "Failed to create worktree");
      }
      return payload.workspace;
    },
    onSuccess: (workspace) => {
      mergeWorkspaces(serverId!, [normalizeWorkspaceDescriptor(workspace)]);
      onWorktreeCreated?.(workspace.id);
      onWorkspacePress?.();
      router.navigate(
        prepareWorkspaceTab({
          serverId: serverId!,
          workspaceId: workspace.id,
          target: { kind: "draft", draftId: "new" },
        }) as any,
      );
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
  useKeyboardActionHandler({
    handlerId: `worktree-new-${project.projectKey}`,
    actions: ["worktree.new"],
    enabled: isProjectActive && canCreateWorktree && !createWorktreeMutation.isPending,
    priority: 0,
    handle: () => {
      createWorktreeMutation.mutate();
      return true;
    },
  });

  const interaction = useLongPressDragInteraction({
    drag,
    menuController,
  });

  const handlePress = useCallback(() => {
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    onPress();
  }, [interaction.didLongPressRef, onPress]);

  const rowChildren = (
    <>
      <View
        {...(dragHandleProps?.attributes as any)}
        {...(dragHandleProps?.listeners as any)}
        ref={dragHandleProps?.setActivatorNodeRef as any}
        style={styles.projectRowLeft}
      >
        <ProjectLeadingVisual
          displayName={displayName}
          iconDataUri={iconDataUri}
          workspace={workspace}
          chevron={chevron}
          showChevron={isHovered && chevron !== null}
          isArchiving={isArchiving}
        />

        <View style={styles.projectTitleGroup}>
          <Text style={styles.projectTitle} numberOfLines={1}>
            {displayName}
          </Text>
        </View>
      </View>
      <View style={styles.projectTrailingActions}>
        {canCreateWorktree ? (
          <NewWorktreeButton
            displayName={displayName}
            onPress={() => createWorktreeMutation.mutate()}
            visible={isHovered || isMobileBreakpoint}
            loading={createWorktreeMutation.isPending}
            showShortcutHint={isProjectActive}
            testID={`sidebar-project-new-worktree-${project.projectKey}`}
          />
        ) : null}
        {onRemoveProject ? (
          <View
            style={!(isHovered || isMobileBreakpoint) && styles.projectKebabButtonHidden}
            pointerEvents={isHovered || isMobileBreakpoint ? "auto" : "none"}
          >
            <DropdownMenu>
              <DropdownMenuTrigger
                hitSlop={8}
                style={({ hovered = false }) => [
                  styles.projectKebabButton,
                  hovered && styles.projectKebabButtonHovered,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Project actions"
                testID={`sidebar-project-kebab-${project.projectKey}`}
              >
                {({ hovered }) => (
                  <MoreVertical
                    size={14}
                    color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                  />
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" width={220}>
                <DropdownMenuItem
                  testID={`sidebar-project-menu-remove-${project.projectKey}`}
                  leading={<Trash2 size={14} color={theme.colors.foregroundMuted} />}
                  status={removeProjectStatus}
                  pendingLabel="Removing..."
                  onSelect={onRemoveProject}
                >
                  Remove project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </View>
        ) : null}
      </View>
      {showShortcutBadge && shortcutNumber !== null ? (
        <View style={styles.shortcutBadge}>
          <Text style={styles.shortcutBadgeText}>{shortcutNumber}</Text>
        </View>
      ) : null}
    </>
  );

  if (menuController) {
    return (
      <View onPointerEnter={() => setIsHovered(true)} onPointerLeave={() => setIsHovered(false)}>
        <ContextMenuTrigger
          enabledOnMobile={false}
          style={({ pressed }) => [
            styles.projectRow,
            isDragging && styles.projectRowDragging,
            selected && styles.sidebarRowSelected,
            isHovered && styles.projectRowHovered,
            pressed && styles.projectRowPressed,
          ]}
          onPressIn={interaction.handlePressIn}
          onTouchMove={interaction.handleTouchMove}
          onPressOut={interaction.handlePressOut}
          onPress={handlePress}
          testID={`sidebar-project-row-${project.projectKey}`}
        >
          {rowChildren}
        </ContextMenuTrigger>
      </View>
    );
  }

  return (
    <View onPointerEnter={() => setIsHovered(true)} onPointerLeave={() => setIsHovered(false)}>
      <Pressable
        style={({ pressed }) => [
          styles.projectRow,
          isDragging && styles.projectRowDragging,
          selected && styles.sidebarRowSelected,
          isHovered && styles.projectRowHovered,
          pressed && styles.projectRowPressed,
        ]}
        onPressIn={interaction.handlePressIn}
        onTouchMove={interaction.handleTouchMove}
        onPressOut={interaction.handlePressOut}
        onPress={handlePress}
        testID={`sidebar-project-row-${project.projectKey}`}
      >
        {rowChildren}
      </Pressable>
    </View>
  );
}

function WorkspaceRowInner({
  workspace,
  selected,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  drag,
  isDragging,
  isArchiving,
  isCreating = false,
  dragHandleProps,
  menuController,
  archiveLabel,
  archiveStatus = "idle",
  archivePendingLabel,
  onArchive,
  onCopyBranchName,
  onCopyPath,
  archiveShortcutKeys,
}: WorkspaceRowInnerProps) {
  const { theme } = useUnistyles();
  const [isHovered, setIsHovered] = useState(false);
  const isTouchPlatform = Platform.OS !== "web";
  const prHint = useWorkspacePrHint({
    serverId: workspace.serverId,
    cwd: workspace.workspaceId,
    enabled: workspace.workspaceKind !== "directory",
  });
  const interaction = useLongPressDragInteraction({
    drag,
    menuController,
  });

  const handlePress = useCallback(() => {
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    onPress();
  }, [interaction.didLongPressRef, onPress]);

  return (
    <View
      style={styles.workspaceRowContainer}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
    >
      <Pressable
        disabled={isArchiving}
        style={({ pressed }) => [
          styles.workspaceRow,
          isDragging && styles.workspaceRowDragging,
          selected && styles.sidebarRowSelected,
          isHovered && styles.workspaceRowHovered,
          pressed && styles.workspaceRowPressed,
        ]}
        onPressIn={interaction.handlePressIn}
        onTouchMove={interaction.handleTouchMove}
        onPressOut={interaction.handlePressOut}
        onPress={handlePress}
        testID={`sidebar-workspace-row-${workspace.workspaceKey}`}
      >
        <View style={styles.workspaceRowMain}>
          <View
            {...(dragHandleProps?.attributes as any)}
            {...(dragHandleProps?.listeners as any)}
            ref={dragHandleProps?.setActivatorNodeRef as any}
            style={styles.workspaceRowLeft}
          >
            <WorkspaceStatusIndicator
              bucket={workspace.statusBucket}
              workspaceKind={workspace.workspaceKind}
              loading={isArchiving || isCreating}
            />
            <Text
              style={[
                styles.workspaceBranchText,
                isHovered && styles.workspaceBranchTextHovered,
                isCreating && styles.workspaceBranchTextCreating,
              ]}
              numberOfLines={1}
            >
              {workspace.name}
            </Text>
          </View>
          <View style={styles.workspaceRowRight}>
            {isCreating ? <Text style={styles.workspaceCreatingText}>Creating...</Text> : null}
            {onArchive && (isHovered || isTouchPlatform) ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  hitSlop={8}
                  style={({ hovered = false }) => [
                    styles.kebabButton,
                    hovered && styles.kebabButtonHovered,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Workspace actions"
                  testID={`sidebar-workspace-kebab-${workspace.workspaceKey}`}
                >
                  {({ hovered }) => (
                    <MoreVertical
                      size={14}
                      color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                    />
                  )}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" width={260}>
                  {onCopyPath ? (
                    <DropdownMenuItem
                      testID={`sidebar-workspace-menu-copy-path-${workspace.workspaceKey}`}
                      leading={<Copy size={14} color={theme.colors.foregroundMuted} />}
                      onSelect={onCopyPath}
                    >
                      Copy path
                    </DropdownMenuItem>
                  ) : null}
                  {onCopyBranchName ? (
                    <DropdownMenuItem
                      testID={`sidebar-workspace-menu-copy-branch-name-${workspace.workspaceKey}`}
                      leading={<Copy size={14} color={theme.colors.foregroundMuted} />}
                      onSelect={onCopyBranchName}
                    >
                      Copy branch name
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    testID={`sidebar-workspace-menu-archive-${workspace.workspaceKey}`}
                    leading={<Archive size={14} color={theme.colors.foregroundMuted} />}
                    trailing={archiveShortcutKeys ? <Shortcut chord={archiveShortcutKeys} /> : null}
                    status={archiveStatus}
                    pendingLabel={archivePendingLabel}
                    onSelect={onArchive}
                  >
                    {archiveLabel ?? "Archive"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : workspace.diffStat ? (
              <View style={styles.diffStatRow}>
                <Text style={styles.diffStatAdditions}>+{workspace.diffStat.additions}</Text>
                <Text style={styles.diffStatDeletions}>-{workspace.diffStat.deletions}</Text>
              </View>
            ) : null}
            {showShortcutBadge && shortcutNumber !== null ? (
              <View style={styles.shortcutBadge}>
                <Text style={styles.shortcutBadgeText}>{shortcutNumber}</Text>
              </View>
            ) : null}
          </View>
        </View>
        {prHint ? (
          <View style={styles.workspacePrBadgeRow}>
            <WorkspacePrBadge hint={prHint} />
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

function WorkspaceRowWithMenu({
  workspace,
  selected,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  drag,
  isDragging,
  dragHandleProps,
  canCopyBranchName,
  isCreating = false,
}: {
  workspace: SidebarWorkspaceEntry;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  canCopyBranchName: boolean;
  isCreating?: boolean;
}) {
  const toast = useToast();
  const activeWorkspaceSelection = useNavigationActiveWorkspaceSelection();
  const archiveWorktree = useCheckoutGitActionsStore((state) => state.archiveWorktree);
  const sessionWorkspaces = useSessionStore(
    (state) => state.sessions[workspace.serverId]?.workspaces ?? EMPTY_WORKSPACES,
  );
  const [isArchivingWorkspace, setIsArchivingWorkspace] = useState(false);
  const archiveStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({
      serverId: workspace.serverId,
      cwd: workspace.workspaceId,
      actionId: "archive-worktree",
    }),
  );
  const isWorktree = workspace.workspaceKind === "worktree";
  const isArchiving = isWorktree ? archiveStatus === "pending" : isArchivingWorkspace;
  const redirectAfterArchive = useCallback(() => {
    if (
      activeWorkspaceSelection?.serverId !== workspace.serverId ||
      activeWorkspaceSelection.workspaceId !== workspace.workspaceId
    ) {
      return;
    }

    router.replace(
      buildWorkspaceArchiveRedirectRoute({
        serverId: workspace.serverId,
        archivedWorkspaceId: workspace.workspaceId,
        workspaces: sessionWorkspaces.values(),
      }),
    );
  }, [activeWorkspaceSelection, sessionWorkspaces, workspace.serverId, workspace.workspaceId]);

  const handleArchiveWorktree = useCallback(() => {
    if (isArchiving) {
      return;
    }

    void (async () => {
      const confirmed = await confirmDialog({
        title: "Archive worktree?",
        message: `Archive "${workspace.name}"?\n\nThe worktree will be removed from disk, terminals will be stopped, and agents inside will be archived.\n\nYour branch is still accessible if you committed.`,
        confirmLabel: "Archive",
        cancelLabel: "Cancel",
        destructive: true,
      });

      if (!confirmed) {
        return;
      }

      void archiveWorktree({
        serverId: workspace.serverId,
        cwd: workspace.workspaceId,
        worktreePath: workspace.workspaceId,
      })
        .then(() => {
          redirectAfterArchive();
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "Failed to archive worktree";
          toast.error(message);
        });
    })();
  }, [
    archiveWorktree,
    isArchiving,
    redirectAfterArchive,
    toast,
    workspace.name,
    workspace.serverId,
    workspace.workspaceId,
  ]);

  const handleArchiveWorkspace = useCallback(() => {
    if (isArchivingWorkspace) {
      return;
    }

    void (async () => {
      const confirmed = await confirmDialog({
        title: "Hide workspace?",
        message: `Hide "${workspace.name}" from the sidebar?\n\nFiles on disk will not be changed.`,
        confirmLabel: "Hide",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) {
        toast.error("Host is not connected");
        return;
      }

      setIsArchivingWorkspace(true);
      try {
        const payload = await client.archiveWorkspace(workspace.workspaceId);
        if (payload.error) {
          throw new Error(payload.error);
        }
        redirectAfterArchive();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to hide workspace");
      } finally {
        setIsArchivingWorkspace(false);
      }
    })();
  }, [
    isArchivingWorkspace,
    redirectAfterArchive,
    toast,
    workspace.name,
    workspace.serverId,
    workspace.workspaceId,
  ]);

  const handleCopyPath = useCallback(() => {
    void Clipboard.setStringAsync(workspace.workspaceId);
    toast.copied("Path copied");
  }, [toast, workspace.workspaceId]);

  const handleCopyBranchName = useCallback(() => {
    void Clipboard.setStringAsync(workspace.name);
    toast.copied("Branch name copied");
  }, [toast, workspace.name]);

  const archiveShortcutKeys = useShortcutKeys("archive-worktree");

  useKeyboardActionHandler({
    handlerId: `worktree-archive-${workspace.workspaceKey}`,
    actions: ["worktree.archive"],
    enabled: selected && !isArchiving,
    priority: 0,
    handle: () => {
      if (isWorktree) {
        handleArchiveWorktree();
      } else {
        handleArchiveWorkspace();
      }
      return true;
    },
  });

  return (
    <WorkspaceRowInner
      workspace={workspace}
      selected={selected}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      onPress={onPress}
      drag={drag}
      isDragging={isDragging}
      isArchiving={isArchiving}
      isCreating={isCreating}
      dragHandleProps={dragHandleProps}
      menuController={null}
      archiveLabel={isWorktree ? "Archive worktree" : "Hide from sidebar"}
      archiveStatus={isWorktree ? archiveStatus : isArchivingWorkspace ? "pending" : "idle"}
      archivePendingLabel={isWorktree ? "Archiving..." : "Hiding..."}
      onArchive={isWorktree ? handleArchiveWorktree : handleArchiveWorkspace}
      onCopyBranchName={canCopyBranchName ? handleCopyBranchName : undefined}
      onCopyPath={handleCopyPath}
      archiveShortcutKeys={selected ? archiveShortcutKeys : null}
    />
  );
}

function FlattenedProjectRow({
  project,
  displayName,
  iconDataUri,
  rowModel,
  onPress,
  serverId,
  onWorkspacePress,
  onWorktreeCreated,
  shortcutNumber,
  showShortcutBadge,
  drag,
  isDragging,
  dragHandleProps,
  isProjectActive = false,
  onRemoveProject,
  removeProjectStatus,
}: {
  project: SidebarProjectEntry;
  displayName: string;
  iconDataUri: string | null;
  rowModel: Extract<ReturnType<typeof buildSidebarProjectRowModel>, { kind: "workspace_link" }>;
  onPress: () => void;
  serverId: string | null;
  onWorkspacePress?: () => void;
  onWorktreeCreated?: (workspaceId: string) => void;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  isProjectActive?: boolean;
  onRemoveProject?: () => void;
  removeProjectStatus?: "idle" | "pending";
}) {
  return (
    <ProjectHeaderRow
      project={project}
      displayName={displayName}
      iconDataUri={iconDataUri}
      workspace={rowModel.workspace}
      selected={rowModel.selected}
      chevron={rowModel.chevron}
      onPress={onPress}
      serverId={serverId}
      canCreateWorktree={rowModel.trailingAction === "new_worktree"}
      isProjectActive={isProjectActive}
      onWorkspacePress={onWorkspacePress}
      onWorktreeCreated={onWorktreeCreated}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      drag={drag}
      isDragging={isDragging}
      menuController={null}
      onRemoveProject={onRemoveProject}
      removeProjectStatus={removeProjectStatus}
      dragHandleProps={dragHandleProps}
    />
  );
}

function WorkspaceRow({
  workspace,
  selected,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  drag,
  isDragging,
  dragHandleProps,
  canCopyBranchName,
  isCreating = false,
}: {
  workspace: SidebarWorkspaceEntry;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  canCopyBranchName: boolean;
  isCreating?: boolean;
}) {
  return (
    <WorkspaceRowWithMenu
      workspace={workspace}
      selected={selected}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      onPress={onPress}
      drag={drag}
      isDragging={isDragging}
      dragHandleProps={dragHandleProps}
      canCopyBranchName={canCopyBranchName}
      isCreating={isCreating}
    />
  );
}

function ProjectBlock({
  project,
  collapsed,
  displayName,
  iconDataUri,
  serverId,
  activeWorkspaceSelection,
  showShortcutBadges,
  shortcutIndexByWorkspaceKey,
  parentGestureRef,
  onToggleCollapsed,
  onWorkspacePress,
  onWorkspaceReorder,
  onWorktreeCreated,
  drag,
  isDragging,
  dragHandleProps,
  useNestable,
  creatingWorkspaceIds,
}: {
  project: SidebarProjectEntry;
  collapsed: boolean;
  displayName: string;
  iconDataUri: string | null;
  serverId: string | null;
  activeWorkspaceSelection: { serverId: string; workspaceId: string } | null;
  showShortcutBadges: boolean;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  onToggleCollapsed: () => void;
  onWorkspacePress?: () => void;
  onWorkspaceReorder: (projectKey: string, workspaces: SidebarWorkspaceEntry[]) => void;
  onWorktreeCreated?: (workspaceId: string) => void;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  useNestable: boolean;
  creatingWorkspaceIds: ReadonlySet<string>;
}) {
  const rowModel = useMemo(
    () =>
      buildSidebarProjectRowModel({
        project,
        collapsed,
        serverId,
        activeWorkspaceSelection,
      }),
    [activeWorkspaceSelection, collapsed, project, serverId],
  );

  const isProjectActive = useMemo(() => {
    if (!serverId || !activeWorkspaceSelection || activeWorkspaceSelection.serverId !== serverId) {
      return false;
    }
    return project.workspaces.some((w) => w.workspaceId === activeWorkspaceSelection.workspaceId);
  }, [serverId, activeWorkspaceSelection, project.workspaces]);

  const renderWorkspaceRow = useCallback(
    (
      item: SidebarWorkspaceEntry,
      input?: {
        drag?: () => void;
        isDragging?: boolean;
        dragHandleProps?: DraggableListDragHandleProps;
      },
    ) => {
      const isSelected =
        Boolean(serverId) &&
        activeWorkspaceSelection?.serverId === serverId &&
        activeWorkspaceSelection.workspaceId === item.workspaceId;

      return (
        <WorkspaceRow
          workspace={item}
          selected={isSelected}
          shortcutNumber={shortcutIndexByWorkspaceKey.get(item.workspaceKey) ?? null}
          showShortcutBadge={showShortcutBadges}
          canCopyBranchName={project.projectKind === "git"}
          isCreating={creatingWorkspaceIds.has(item.workspaceId)}
          onPress={() => {
            if (!serverId) {
              return;
            }
            onWorkspacePress?.();
            navigateToWorkspace(serverId, item.workspaceId);
          }}
          drag={input?.drag ?? (() => {})}
          isDragging={input?.isDragging ?? false}
          dragHandleProps={input?.dragHandleProps}
        />
      );
    },
    [
      activeWorkspaceSelection,
      project.projectKind,
      creatingWorkspaceIds,
      onWorkspacePress,
      serverId,
      shortcutIndexByWorkspaceKey,
      showShortcutBadges,
    ],
  );

  const renderWorkspace = useCallback(
    ({
      item,
      drag: workspaceDrag,
      isActive,
      dragHandleProps: workspaceDragHandleProps,
    }: DraggableRenderItemInfo<SidebarWorkspaceEntry>) => {
      return renderWorkspaceRow(item, {
        drag: workspaceDrag,
        isDragging: isActive,
        dragHandleProps: workspaceDragHandleProps,
      });
    },
    [renderWorkspaceRow],
  );

  const handleWorkspaceDragEnd = useCallback(
    (workspaces: SidebarWorkspaceEntry[]) => {
      onWorkspaceReorder(project.projectKey, workspaces);
    },
    [onWorkspaceReorder, project.projectKey],
  );

  const toast = useToast();
  const [isRemovingProject, setIsRemovingProject] = useState(false);

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
      try {
        for (const ws of project.workspaces) {
          const payload = await client.archiveWorkspace(ws.workspaceId);
          if (payload.error) {
            throw new Error(payload.error);
          }
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to remove project");
      } finally {
        setIsRemovingProject(false);
      }
    })();
  }, [isRemovingProject, serverId, displayName, toast, project.workspaces]);

  return (
    <View style={styles.projectBlock}>
      {rowModel.kind === "workspace_link" ? (
        <FlattenedProjectRow
          project={project}
          displayName={displayName}
          iconDataUri={iconDataUri}
          rowModel={rowModel}
          onPress={() => {
            if (!serverId) {
              return;
            }
            onWorkspacePress?.();
            navigateToWorkspace(serverId, rowModel.workspace.workspaceId);
          }}
          serverId={serverId}
          onWorkspacePress={onWorkspacePress}
          onWorktreeCreated={onWorktreeCreated}
          shortcutNumber={shortcutIndexByWorkspaceKey.get(rowModel.workspace.workspaceKey) ?? null}
          showShortcutBadge={showShortcutBadges}
          drag={drag}
          isDragging={isDragging}
          dragHandleProps={dragHandleProps}
          isProjectActive={isProjectActive}
          onRemoveProject={handleRemoveProject}
          removeProjectStatus={isRemovingProject ? "pending" : "idle"}
        />
      ) : (
        <>
          <ProjectHeaderRow
            project={project}
            displayName={displayName}
            iconDataUri={iconDataUri}
            workspace={null}
            selected={false}
            chevron={rowModel.chevron}
            onPress={onToggleCollapsed}
            serverId={serverId}
            canCreateWorktree={rowModel.trailingAction === "new_worktree"}
            isProjectActive={isProjectActive}
            onWorkspacePress={onWorkspacePress}
            onWorktreeCreated={onWorktreeCreated}
            drag={drag}
            isDragging={isDragging}
            isArchiving={isRemovingProject}
            menuController={null}
            onRemoveProject={handleRemoveProject}
            removeProjectStatus={isRemovingProject ? "pending" : "idle"}
            dragHandleProps={dragHandleProps}
          />

          {!collapsed ? (
            <DraggableList
              testID={`sidebar-workspace-list-${project.projectKey}`}
              data={project.workspaces}
              keyExtractor={workspaceKeyExtractor}
              renderItem={renderWorkspace}
              onDragEnd={handleWorkspaceDragEnd}
              scrollEnabled={false}
              useDragHandle
              nestable={useNestable}
              simultaneousGestureRef={parentGestureRef}
              containerStyle={styles.workspaceListContainer}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

export function SidebarWorkspaceList({
  projects,
  serverId,
  collapsedProjectKeys,
  onToggleProjectCollapsed,
  shortcutIndexByWorkspaceKey,
  isRefreshing = false,
  onRefresh,
  onWorkspacePress,
  onAddProject,
  listFooterComponent,
  parentGestureRef,
}: SidebarWorkspaceListProps) {
  const isMobile = isCompactFormFactor();
  const isNative = Platform.OS !== "web";
  const pathname = usePathname();
  const activeWorkspaceSelection = useNavigationActiveWorkspaceSelection();
  const [creatingWorkspaceIds, setCreatingWorkspaceIds] = useState<Set<string>>(() => new Set());
  const creatingWorkspaceTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const isDesktopApp = getIsElectronRuntime();
  const altDown = useKeyboardShortcutsStore((state) => state.altDown);
  const cmdOrCtrlDown = useKeyboardShortcutsStore((state) => state.cmdOrCtrlDown);
  const showShortcutBadges = altDown || (isDesktopApp && cmdOrCtrlDown);

  const getProjectOrder = useSidebarOrderStore((state) => state.getProjectOrder);
  const setProjectOrder = useSidebarOrderStore((state) => state.setProjectOrder);
  const getWorkspaceOrder = useSidebarOrderStore((state) => state.getWorkspaceOrder);
  const setWorkspaceOrder = useSidebarOrderStore((state) => state.setWorkspaceOrder);

  const isWorkspaceRoute = useMemo(
    () => Boolean(pathname && parseHostWorkspaceRouteFromPathname(pathname)),
    [pathname],
  );
  const effectiveActiveWorkspaceSelection = isWorkspaceRoute ? activeWorkspaceSelection : null;

  const projectIconRequests = useMemo(() => {
    if (!serverId) {
      return [];
    }
    const unique = new Map<string, { serverId: string; cwd: string }>();
    for (const project of projects) {
      const cwd = project.iconWorkingDir.trim();
      if (!cwd) {
        continue;
      }
      unique.set(`${serverId}:${cwd}`, { serverId, cwd });
    }
    return Array.from(unique.values());
  }, [projects, serverId]);

  const projectIconQueries = useQueries({
    queries: projectIconRequests.map((request) => ({
      queryKey: projectIconQueryKey(request.serverId, request.cwd),
      queryFn: async () => {
        const client = getHostRuntimeStore().getClient(request.serverId);
        if (!client) {
          return null;
        }
        const result = await client.requestProjectIcon(request.cwd);
        return result.icon;
      },
      select: toProjectIconDataUri,
      enabled: Boolean(
        getHostRuntimeStore().getClient(request.serverId) &&
          isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(request.serverId)) &&
          request.cwd,
      ),
      staleTime: Infinity,
      gcTime: 1000 * 60 * 60,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
  });

  const projectIconByProjectKey = useMemo(() => {
    const iconByServerAndCwd = new Map<string, string | null>();
    for (let index = 0; index < projectIconRequests.length; index += 1) {
      const request = projectIconRequests[index];
      if (!request) {
        continue;
      }
      iconByServerAndCwd.set(
        `${request.serverId}:${request.cwd}`,
        projectIconQueries[index]?.data ?? null,
      );
    }

    const byProject = new Map<string, string | null>();
    for (const project of projects) {
      const cwd = project.iconWorkingDir.trim();
      if (!cwd || !serverId) {
        byProject.set(project.projectKey, null);
        continue;
      }
      byProject.set(project.projectKey, iconByServerAndCwd.get(`${serverId}:${cwd}`) ?? null);
    }

    return byProject;
  }, [projectIconQueries, projectIconRequests, projects, serverId]);

  useEffect(() => {
    return () => {
      for (const timeout of creatingWorkspaceTimeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
      creatingWorkspaceTimeoutsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (creatingWorkspaceIds.size === 0) {
      return;
    }

    const visibleWorkspaceIds = new Set<string>();
    for (const project of projects) {
      for (const workspace of project.workspaces) {
        visibleWorkspaceIds.add(workspace.workspaceId);
      }
    }

    const removedWorkspaceIds = Array.from(creatingWorkspaceIds).filter(
      (workspaceId) => !visibleWorkspaceIds.has(workspaceId),
    );
    if (removedWorkspaceIds.length === 0) {
      return;
    }

    for (const workspaceId of removedWorkspaceIds) {
      const timeout = creatingWorkspaceTimeoutsRef.current.get(workspaceId);
      if (timeout) {
        clearTimeout(timeout);
        creatingWorkspaceTimeoutsRef.current.delete(workspaceId);
      }
    }

    setCreatingWorkspaceIds((current) => {
      const next = new Set(current);
      for (const workspaceId of removedWorkspaceIds) {
        next.delete(workspaceId);
      }
      return next;
    });
  }, [creatingWorkspaceIds, projects]);

  const handleProjectDragEnd = useCallback(
    (reorderedProjects: SidebarProjectEntry[]) => {
      if (!serverId) {
        return;
      }

      const reorderedProjectKeys = reorderedProjects.map((project) => project.projectKey);
      const currentProjectOrder = getProjectOrder(serverId);
      if (
        !hasVisibleOrderChanged({
          currentOrder: currentProjectOrder,
          reorderedVisibleKeys: reorderedProjectKeys,
        })
      ) {
        return;
      }

      setProjectOrder(
        serverId,
        mergeWithRemainder({
          currentOrder: currentProjectOrder,
          reorderedVisibleKeys: reorderedProjectKeys,
        }),
      );
    },
    [getProjectOrder, serverId, setProjectOrder],
  );

  const handleWorkspaceReorder = useCallback(
    (projectKey: string, reorderedWorkspaces: SidebarWorkspaceEntry[]) => {
      if (!serverId) {
        return;
      }

      const reorderedWorkspaceKeys = reorderedWorkspaces.map((workspace) => workspace.workspaceKey);
      const currentWorkspaceOrder = getWorkspaceOrder(serverId, projectKey);
      if (
        !hasVisibleOrderChanged({
          currentOrder: currentWorkspaceOrder,
          reorderedVisibleKeys: reorderedWorkspaceKeys,
        })
      ) {
        return;
      }

      setWorkspaceOrder(
        serverId,
        projectKey,
        mergeWithRemainder({
          currentOrder: currentWorkspaceOrder,
          reorderedVisibleKeys: reorderedWorkspaceKeys,
        }),
      );
    },
    [getWorkspaceOrder, serverId, setWorkspaceOrder],
  );

  const handleWorktreeCreated = useCallback(
    (workspaceId: string) => {
      setCreatingWorkspaceIds((current) => {
        const next = new Set(current);
        next.add(workspaceId);
        return next;
      });
      const existingTimeout = creatingWorkspaceTimeoutsRef.current.get(workspaceId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }
      creatingWorkspaceTimeoutsRef.current.set(
        workspaceId,
        setTimeout(() => {
          creatingWorkspaceTimeoutsRef.current.delete(workspaceId);
          setCreatingWorkspaceIds((current) => {
            if (!current.has(workspaceId)) {
              return current;
            }
            const next = new Set(current);
            next.delete(workspaceId);
            return next;
          });
        }, 3000),
      );
    },
    [],
  );

  const renderProject = useCallback(
    ({ item, drag, isActive, dragHandleProps }: DraggableRenderItemInfo<SidebarProjectEntry>) => {
      return (
        <ProjectBlock
          project={item}
          collapsed={collapsedProjectKeys.has(item.projectKey)}
          displayName={item.projectName}
          iconDataUri={projectIconByProjectKey.get(item.projectKey) ?? null}
          serverId={serverId}
          activeWorkspaceSelection={effectiveActiveWorkspaceSelection}
          showShortcutBadges={showShortcutBadges}
          shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
          parentGestureRef={parentGestureRef}
          onToggleCollapsed={() => onToggleProjectCollapsed(item.projectKey)}
          onWorkspacePress={onWorkspacePress}
          onWorkspaceReorder={handleWorkspaceReorder}
          onWorktreeCreated={handleWorktreeCreated}
          drag={drag}
          isDragging={isActive}
          dragHandleProps={dragHandleProps}
          useNestable={isNative}
          creatingWorkspaceIds={creatingWorkspaceIds}
        />
      );
    },
    [
      collapsedProjectKeys,
      effectiveActiveWorkspaceSelection,
      handleWorktreeCreated,
      handleWorkspaceReorder,
      onWorkspacePress,
      onToggleProjectCollapsed,
      parentGestureRef,
      projectIconByProjectKey,
      serverId,
      shortcutIndexByWorkspaceKey,
      showShortcutBadges,
      isNative,
      creatingWorkspaceIds,
    ],
  );

  const content = (
    <>
      {projects.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyTitle}>No projects yet</Text>
          <Text style={styles.emptyText}>Add a project to get started</Text>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Plus}
            onPress={onAddProject}
          >
            Add project
          </Button>
        </View>
      ) : (
        <DraggableList
          testID="sidebar-project-list"
          data={projects}
          keyExtractor={projectKeyExtractor}
          renderItem={renderProject}
          onDragEnd={handleProjectDragEnd}
          scrollEnabled={false}
          useDragHandle
          nestable={isNative}
          simultaneousGestureRef={parentGestureRef}
          containerStyle={styles.projectListContainer}
        />
      )}
      {listFooterComponent}
    </>
  );

  return (
    <View style={styles.container}>
      {isNative ? (
        <NestableScrollContainer
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-project-workspace-list-scroll"
        >
          {content}
        </NestableScrollContainer>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-project-workspace-list-scroll"
        >
          {content}
        </ScrollView>
      )}
    </View>
  );
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
  projectListContainer: {
    width: "100%",
  },
  projectBlock: {
    marginBottom: theme.spacing[1],
  },
  workspaceListContainer: {},
  emptyContainer: {
    marginHorizontal: theme.spacing[2],
    marginTop: theme.spacing[4],
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    gap: theme.spacing[3],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  projectRow: {
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  projectRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  projectRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  projectRowDragging: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    transform: [{ scale: 1.02 }],
    zIndex: 3,
    ...theme.shadow.md,
  },
  projectRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  projectTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  projectIcon: {
    width: "100%",
    height: "100%",
    borderRadius: theme.borderRadius.sm,
  },
  projectLeadingVisualSlot: {
    position: "relative",
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  projectIconFallback: {
    width: "100%",
    height: "100%",
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  projectIconFallbackText: {
    color: theme.colors.foregroundMuted,
    fontSize: 9,
  },
  projectTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "400",
    minWidth: 0,
    flexShrink: 1,
  },
  projectActionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  projectActionButtonHovered: {
    backgroundColor: theme.colors.surface1,
  },
  projectActionButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  projectIconActionButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  projectIconActionButtonHovered: {
    backgroundColor: theme.colors.surface1,
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
  projectActionTooltipShortcut: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.borderAccent,
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
    justifyContent: "center",
    gap: theme.spacing[1],
  },
  workspaceRowMain: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    width: "100%",
  },
  workspaceRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  workspaceRowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  workspaceRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  workspaceRowPressed: {
    backgroundColor: theme.colors.surface2,
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
    backgroundColor: theme.colors.surface1,
  },
  workspaceRowContainer: {
    position: "relative",
  },
  workspaceStatusDot: {
    position: "relative",
    width: WORKSPACE_STATUS_DOT_WIDTH,
    height: 16,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  statusDotOverlay: {
    position: "absolute",
    right: DEFAULT_STATUS_DOT_OFFSET,
    bottom: DEFAULT_STATUS_DOT_OFFSET,
    width: DEFAULT_STATUS_DOT_SIZE,
    height: DEFAULT_STATUS_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  workspaceArchivingOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: `${theme.colors.surface0}cc`,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    zIndex: 1,
  },
  workspaceArchivingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
  },
  workspaceBranchText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "400",
    lineHeight: 20,
    opacity: 0.76,
    flex: 1,
    minWidth: 0,
  },
  workspaceBranchTextCreating: {
    opacity: 0.92,
  },
  workspaceBranchTextHovered: {
    opacity: 1,
  },
  workspacePrBadgeRow: {
    paddingLeft: WORKSPACE_STATUS_DOT_WIDTH + theme.spacing[2],
  },
  workspacePrBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  workspacePrBadgePressed: {
    opacity: 0.82,
  },
  workspacePrBadgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 14,
  },
  workspaceCreatingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flexShrink: 0,
  },
  diffStatRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  diffStatAdditions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.green[400],
  },
  diffStatDeletions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.red[500],
  },
  kebabButton: {
    padding: 2,
    borderRadius: 4,
    marginLeft: 2,
  },
  kebabButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  shortcutBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface0,
    flexShrink: 0,
  },
  shortcutBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 14,
  },
}));
