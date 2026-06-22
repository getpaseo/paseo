import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  ScrollView,
  type GestureResponderEvent,
  type PressableStateCallbackType,
  type ViewStyle,
} from "react-native";
import { ProjectIconView } from "@/components/project-icon-view";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  useEffect,
  useRef,
  type ReactElement,
  type MutableRefObject,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { router, usePathname, type Href } from "expo-router";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { type GestureType } from "react-native-gesture-handler";
import {
  CircleAlert,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitPullRequest,
  Settings,
  MoreVertical,
  Plus,
  Trash2,
} from "lucide-react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import { DraggableList, type DraggableRenderItemInfo } from "./draggable-list";
import type { DraggableListDragHandleProps } from "./draggable-list.types";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useProjectIconDataByProjectKey } from "@/projects/project-icons";
import {
  buildHostNewWorkspaceRoute,
  buildProjectSettingsRoute,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import {
  useSidebarWorkspaceEntry,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSessionStore } from "@/stores/session-store";
import { useShowShortcutBadges } from "@/hooks/use-show-shortcut-badges";
import { ContextMenuTrigger, useContextMenu } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { SyncedLoader } from "@/components/synced-loader";
import { useToast } from "@/contexts/toast-context";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";
import { SidebarWorkspaceRow } from "@/components/sidebar/sidebar-workspace-row";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";
import { confirmDialog } from "@/utils/confirm-dialog";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";
import { isEmphasizedStatusDotBucket } from "@/utils/status-dot-color";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { SidebarStatusWorkspaceList } from "@/components/sidebar/sidebar-status-list";
import { SidebarWorkspaceShortcutBadge } from "@/components/sidebar/sidebar-workspace-row-content";
import {
  useProjectNamesMap,
  useStatusModeWorkspaceEntries,
} from "@/hooks/use-status-mode-workspaces";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { PrHint } from "@/git/use-pr-status-query";
import { buildSidebarProjectRowModel } from "@/utils/sidebar-project-row-model";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  isWeb as platformIsWeb,
  isNative as platformIsNative,
  getIsElectron,
} from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";

const workspaceKeyExtractor = (workspace: SidebarWorkspaceEntry) => workspace.workspaceKey;

const projectKeyExtractor = (project: SidebarProjectEntry) => project.projectKey;

const DEFAULT_STATUS_DOT_SIZE = 7;
const EMPHASIZED_STATUS_DOT_SIZE = 9;
const DEFAULT_STATUS_DOT_OFFSET = 0;
const EMPHASIZED_STATUS_DOT_OFFSET = -1;
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedSyncedLoader = withUnistyles(SyncedLoader);
const ThemedPlus = withUnistyles(Plus);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedSettings = withUnistyles(Settings);

const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const redColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.red[500],
});
const amberColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.amber[500],
});
const greenColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.green[500],
});
const purpleColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.purple[500],
});
const syncedLoaderColorMapping = (theme: Theme) => ({
  color:
    theme.colorScheme === "light"
      ? theme.colors.palette.amber[700]
      : theme.colors.palette.amber[500],
});

function getPrIconUniMapping(state: PrHint["state"]) {
  switch (state) {
    case "merged":
      return purpleColorMapping;
    case "open":
      return greenColorMapping;
    case "closed":
      return redColorMapping;
  }
}

function isWorkspaceSelected(input: {
  selection: ActiveWorkspaceSelection | null;
  serverId: string | null;
  workspaceId: string;
  enabled: boolean;
}): boolean {
  return (
    input.enabled &&
    input.selection?.serverId === input.serverId &&
    input.selection.workspaceId === input.workspaceId
  );
}

function isProjectSelectedByRoute(input: {
  selection: ActiveWorkspaceSelection | null;
  project: SidebarProjectEntry;
  serverId: string | null;
  enabled: boolean;
}): boolean {
  return (
    input.enabled &&
    input.selection?.serverId === input.serverId &&
    input.project.workspaces.some(
      (workspace) => workspace.workspaceId === input.selection?.workspaceId,
    )
  );
}

function navigateToNewWorkspaceForProject(input: {
  serverId: string | null;
  project: SidebarProjectEntry;
  displayName: string;
  onWorkspacePress?: () => void;
}) {
  if (!input.serverId) {
    return;
  }
  input.onWorkspacePress?.();
  router.navigate(
    buildHostNewWorkspaceRoute(input.serverId, input.project.iconWorkingDir, {
      displayName: input.displayName,
      projectId: input.project.projectKey,
    }) as Href,
  );
}

function activeWorkspaceSelectionKey(selection: ActiveWorkspaceSelection | null): string {
  return selection ? `${selection.serverId}:${selection.workspaceId}` : "";
}

interface SidebarWorkspaceListProps {
  projects: SidebarProjectEntry[];
  serverId: string | null;
  collapsedProjectKeys: ReadonlySet<string>;
  onToggleProjectCollapsed: (projectKey: string) => void;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  groupMode: "project" | "status";
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

export function PrBadge({ hint }: { hint: PrHint }) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);

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

  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);

  const textStyle = isHovered ? prBadgeTextHoveredCombined : prBadgeStyles.text;
  const iconUniProps = isHovered ? foregroundColorMapping : getPrIconUniMapping(hint.state);

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t("workspace.git.pr.accessibility.pullRequest", {
        number: hint.number,
      })}
      hitSlop={4}
      onPressIn={handlePressIn}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={prBadgePressableStyle}
    >
      {isHovered ? (
        <ThemedExternalLink size={12} uniProps={iconUniProps} />
      ) : (
        <ThemedGitPullRequest size={12} uniProps={iconUniProps} />
      )}
      <Text style={textStyle} numberOfLines={1}>
        {hint.number}
      </Text>
    </Pressable>
  );
}

function prBadgePressableStyle({ pressed }: PressableStateCallbackType) {
  return [prBadgeStyles.badge, pressed && prBadgeStyles.badgePressed];
}

function projectKebabStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.projectKebabButton, hovered && styles.projectKebabButtonHovered];
}

function noop() {}

const prBadgeStyles = StyleSheet.create((theme) => ({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  badgePressed: {
    opacity: 0.82,
  },
  text: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 14,
    color: theme.colors.foregroundMuted,
  },
  textHovered: {
    color: theme.colors.foreground,
  },
}));

const prBadgeTextHoveredCombined = [prBadgeStyles.text, prBadgeStyles.textHovered];

function StatusDotOverlay({
  dotColorStyle,
  size,
  offset,
}: {
  dotColorStyle: ViewStyle;
  size: number;
  offset: number;
}) {
  const overlayStyle = useMemo(
    () => [
      styles.statusDotOverlay,
      dotColorStyle,
      {
        width: size,
        height: size,
        right: offset,
        bottom: offset,
      },
    ],
    [dotColorStyle, size, offset],
  );
  return <View style={overlayStyle} />;
}

function ProjectLeadingVisual({
  displayName,
  iconDataUri,
  workspace,
  projectKey,
  chevron = null,
  showChevron = false,
  isArchiving = false,
}: {
  displayName: string;
  iconDataUri: string | null;
  workspace: SidebarWorkspaceEntry | null;
  projectKey: string;
  chevron?: "expand" | "collapse" | null;
  showChevron?: boolean;
  isArchiving?: boolean;
}) {
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

  if (!shouldShowWorkspaceStatus || !activeWorkspace) {
    return (
      <View style={styles.projectLeadingVisualSlot}>
        <ProjectIcon
          iconDataUri={iconDataUri}
          placeholderInitial={placeholderInitial}
          projectKey={projectKey}
        />
      </View>
    );
  }

  return (
    <ProjectLeadingVisualStatus
      iconDataUri={iconDataUri}
      placeholderInitial={placeholderInitial}
      projectKey={projectKey}
      isArchiving={isArchiving}
      shouldShowSyncedLoader={shouldShowSyncedLoader}
      activeWorkspace={activeWorkspace}
    />
  );
}

function ProjectRowTrailingActions({
  project,
  displayName,
  canCreateWorktree,
  isHovered,
  isMobileBreakpoint,
  isProjectActive,
  onBeginWorkspaceSetup,
  onRemoveProject,
  removeProjectStatus,
}: {
  project: SidebarProjectEntry;
  displayName: string;
  canCreateWorktree: boolean;
  isHovered: boolean;
  isMobileBreakpoint: boolean;
  isProjectActive: boolean;
  onBeginWorkspaceSetup: () => void;
  onRemoveProject?: () => void;
  removeProjectStatus: "idle" | "pending" | "success";
}) {
  const actionsVisible = isHovered || platformIsNative || isMobileBreakpoint;
  return (
    <View style={styles.projectTrailingActions}>
      {canCreateWorktree ? (
        <NewWorktreeButton
          displayName={displayName}
          onPress={onBeginWorkspaceSetup}
          visible={actionsVisible}
          showShortcutHint={isProjectActive}
          testID={`sidebar-project-new-worktree-${project.projectKey}`}
        />
      ) : null}
      {onRemoveProject ? (
        <View
          style={!actionsVisible && styles.projectKebabButtonHidden}
          pointerEvents={actionsVisible ? "auto" : "none"}
        >
          <ProjectKebabMenu
            projectKey={project.projectKey}
            projectPath={project.iconWorkingDir}
            onRemoveProject={onRemoveProject}
            removeProjectStatus={removeProjectStatus}
          />
        </View>
      ) : null}
    </View>
  );
}

const trash2LeadingIcon = <ThemedTrash2 size={14} uniProps={foregroundMutedColorMapping} />;
const settingsLeadingIcon = <ThemedSettings size={14} uniProps={foregroundMutedColorMapping} />;
const openInNewWindowLeadingIcon = (
  <ThemedExternalLink size={14} uniProps={foregroundMutedColorMapping} />
);

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
  projectPath,
  onRemoveProject,
  removeProjectStatus,
}: {
  projectKey: string;
  projectPath: string;
  onRemoveProject: () => void;
  removeProjectStatus: "idle" | "pending" | "success";
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const handleOpenProjectSettings = useCallback(() => {
    if (projectKey.trim().length === 0) return;
    router.navigate(buildProjectSettingsRoute(projectKey));
  }, [projectKey]);
  const canOpenProjectSettings = projectKey.trim().length > 0;
  // Desktop-only: open a second window that lands on this project via the same
  // open-project flow as a CLI launch. The project stays visible here too — no
  // ownership, no move.
  const canOpenInNewWindow = getIsElectron() && projectPath.trim().length > 0;
  const handleOpenInNewWindow = useCallback(() => {
    const trimmedPath = projectPath.trim();
    if (trimmedPath.length === 0) return;
    void getDesktopHost()
      ?.window?.openNew?.({ pendingOpenProjectPath: trimmedPath })
      ?.catch((error) => {
        console.warn("[sidebar] openNew failed", error);
        toast.error(t("sidebar.project.actions.openNewWindowFailed"));
      });
  }, [projectPath, t, toast]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={projectKebabStyle}
        accessibilityRole={platformIsWeb ? undefined : "button"}
        accessibilityLabel={t("sidebar.project.actions.menu")}
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
            {t("sidebar.project.actions.openSettings")}
          </DropdownMenuItem>
        ) : null}
        {canOpenInNewWindow ? (
          <DropdownMenuItem
            testID={`sidebar-project-menu-open-new-window-${projectKey}`}
            leading={openInNewWindowLeadingIcon}
            onSelect={handleOpenInNewWindow}
          >
            {t("sidebar.project.actions.openNewWindow")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          testID={`sidebar-project-menu-remove-${projectKey}`}
          leading={trash2LeadingIcon}
          status={removeProjectStatus}
          pendingLabel={t("sidebar.project.actions.removing")}
          onSelect={onRemoveProject}
        >
          {t("sidebar.project.actions.remove")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectIcon({
  iconDataUri,
  placeholderInitial,
  projectKey,
}: {
  iconDataUri: string | null;
  placeholderInitial: string;
  projectKey: string;
}) {
  return (
    <ProjectIconView
      iconDataUri={iconDataUri}
      initial={placeholderInitial}
      projectKey={projectKey}
      imageStyle={styles.projectIcon}
      fallbackStyle={styles.projectIconFallback}
      textStyle={styles.projectIconFallbackText}
    />
  );
}

function ProjectLeadingVisualStatus({
  iconDataUri,
  placeholderInitial,
  projectKey,
  isArchiving,
  shouldShowSyncedLoader,
  activeWorkspace,
}: {
  iconDataUri: string | null;
  placeholderInitial: string;
  projectKey: string;
  isArchiving: boolean;
  shouldShowSyncedLoader: boolean;
  activeWorkspace: SidebarWorkspaceEntry;
}) {
  if (isArchiving) {
    return (
      <View style={styles.projectLeadingVisualSlot}>
        <ThemedActivityIndicator size={8} uniProps={foregroundMutedColorMapping} />
      </View>
    );
  }

  if (shouldShowSyncedLoader) {
    return (
      <View style={styles.projectLeadingVisualSlot}>
        <ThemedSyncedLoader size={11} uniProps={syncedLoaderColorMapping} />
      </View>
    );
  }

  if (activeWorkspace.statusBucket === "needs_input") {
    return (
      <View style={styles.projectLeadingVisualSlot}>
        <ThemedCircleAlert size={14} uniProps={amberColorMapping} />
      </View>
    );
  }

  const dotColorStyle = getStatusDotColorStyle(activeWorkspace.statusBucket);
  const statusDotSize = isEmphasizedStatusDotBucket(activeWorkspace.statusBucket)
    ? EMPHASIZED_STATUS_DOT_SIZE
    : DEFAULT_STATUS_DOT_SIZE;
  const statusDotOffset =
    statusDotSize === EMPHASIZED_STATUS_DOT_SIZE
      ? EMPHASIZED_STATUS_DOT_OFFSET
      : DEFAULT_STATUS_DOT_OFFSET;

  return (
    <View style={styles.projectLeadingVisualSlot}>
      <ProjectIcon
        iconDataUri={iconDataUri}
        placeholderInitial={placeholderInitial}
        projectKey={projectKey}
      />
      {dotColorStyle ? (
        <StatusDotOverlay
          dotColorStyle={dotColorStyle}
          size={statusDotSize}
          offset={statusDotOffset}
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
  const { t } = useTranslation();
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

  return (
    <View style={styles.projectTrailingControlSlot} pointerEvents={visible ? "auto" : "none"}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild disabled={!visible}>
          <Pressable
            style={pressableStyle}
            onPress={handlePress}
            disabled={loading}
            accessibilityRole={platformIsWeb ? undefined : "button"}
            accessibilityLabel={t("sidebar.workspace.actions.createWorkspaceFor", {
              projectName: displayName,
            })}
            testID={testID}
          >
            {({ hovered, pressed }) =>
              loading ? (
                <ThemedActivityIndicator size={14} uniProps={foregroundMutedColorMapping} />
              ) : (
                <ThemedPlus
                  size={15}
                  uniProps={
                    hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping
                  }
                />
              )
            }
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <View style={styles.projectActionTooltipRow}>
            <Text style={styles.projectActionTooltipText}>
              {t("sidebar.workspace.actions.newWorkspace")}
            </Text>
            {showShortcutHint && newWorktreeKeys ? (
              <Shortcut chord={newWorktreeKeys} style={styles.projectActionTooltipShortcut} />
            ) : null}
          </View>
        </TooltipContent>
      </Tooltip>
    </View>
  );
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
  onWorktreeCreated: _onWorktreeCreated,
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
  const [isHovered, setIsHovered] = useState(false);
  const isMobileBreakpoint = useIsCompactFormFactor();
  const handleBeginWorkspaceSetup = useCallback(() => {
    navigateToNewWorkspaceForProject({ serverId, project, displayName, onWorkspacePress });
  }, [displayName, onWorkspacePress, project, serverId]);
  const interaction = useLongPressDragInteraction({
    drag,
    menuController,
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

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const projectRowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.projectRow,
      isDragging && styles.projectRowDragging,
      selected && styles.sidebarRowSelected,
      isHovered && styles.projectRowHovered,
      pressed && styles.projectRowPressed,
    ],
    [isDragging, selected, isHovered],
  );

  const rowChildren = (
    <>
      <View style={styles.projectRowLeft}>
        <ProjectLeadingVisual
          displayName={displayName}
          iconDataUri={iconDataUri}
          workspace={workspace}
          projectKey={project.projectKey}
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
      <ProjectRowTrailingActions
        project={project}
        displayName={displayName}
        canCreateWorktree={canCreateWorktree}
        isHovered={isHovered}
        isMobileBreakpoint={isMobileBreakpoint}
        isProjectActive={isProjectActive}
        onBeginWorkspaceSetup={handleBeginWorkspaceSetup}
        onRemoveProject={onRemoveProject}
        removeProjectStatus={removeProjectStatus}
      />
      {showShortcutBadge && shortcutNumber !== null ? (
        <View style={styles.projectShortcutBadgeOverlay} pointerEvents="none">
          <SidebarWorkspaceShortcutBadge number={shortcutNumber} />
        </View>
      ) : null}
    </>
  );

  if (menuController) {
    return (
      <View
        {...dragAttributes}
        {...dragHandleProps?.listeners}
        ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <ContextMenuTrigger
          enabledOnMobile={false}
          accessibilityRole="button"
          style={projectRowStyle}
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
    <View
      {...dragAttributes}
      {...dragHandleProps?.listeners}
      ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        accessibilityRole="button"
        style={projectRowStyle}
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

interface WorkspaceRowItemProps {
  workspace: SidebarWorkspaceEntry;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  canCopyBranchName: boolean;
  isCreating?: boolean;
  selectionEnabled: boolean;
  serverId: string | null;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  onWorkspacePress?: () => void;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

function WorkspaceRowItem({
  workspace,
  shortcutNumber,
  showShortcutBadge,
  canCopyBranchName,
  isCreating = false,
  selectionEnabled,
  serverId,
  activeWorkspaceSelection,
  onWorkspacePress,
  drag,
  isDragging = false,
  dragHandleProps,
}: WorkspaceRowItemProps) {
  const handlePress = useCallback(() => {
    if (!serverId) {
      return;
    }
    onWorkspacePress?.();
    navigateToWorkspace(serverId, workspace.workspaceId);
  }, [serverId, onWorkspacePress, workspace.workspaceId]);

  return (
    <WorkspaceRow
      workspace={workspace}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      canCopyBranchName={canCopyBranchName}
      isCreating={isCreating}
      selected={isWorkspaceSelected({
        selection: activeWorkspaceSelection,
        serverId: workspace.serverId,
        workspaceId: workspace.workspaceId,
        enabled: selectionEnabled,
      })}
      onPress={handlePress}
      drag={drag ?? noop}
      isDragging={isDragging}
      dragHandleProps={dragHandleProps}
    />
  );
}

function areWorkspaceRowItemPropsEqual(
  previous: WorkspaceRowItemProps,
  next: WorkspaceRowItemProps,
): boolean {
  const previousSelected = isWorkspaceSelected({
    selection: previous.activeWorkspaceSelection,
    serverId: previous.workspace.serverId,
    workspaceId: previous.workspace.workspaceId,
    enabled: previous.selectionEnabled,
  });
  const nextSelected = isWorkspaceSelected({
    selection: next.activeWorkspaceSelection,
    serverId: next.workspace.serverId,
    workspaceId: next.workspace.workspaceId,
    enabled: next.selectionEnabled,
  });
  return (
    previous.workspace === next.workspace &&
    previous.shortcutNumber === next.shortcutNumber &&
    previous.showShortcutBadge === next.showShortcutBadge &&
    previous.canCopyBranchName === next.canCopyBranchName &&
    previous.isCreating === next.isCreating &&
    previous.serverId === next.serverId &&
    previous.onWorkspacePress === next.onWorkspacePress &&
    previous.drag === next.drag &&
    previous.isDragging === next.isDragging &&
    previous.dragHandleProps === next.dragHandleProps &&
    previousSelected === nextSelected
  );
}

const MemoWorkspaceRowItem = memo(WorkspaceRowItem, areWorkspaceRowItemPropsEqual);

function WorkspaceRow({
  workspace,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  drag,
  isDragging,
  dragHandleProps,
  canCopyBranchName,
  isCreating = false,
  selected,
}: {
  workspace: SidebarWorkspaceEntry;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  canCopyBranchName: boolean;
  isCreating?: boolean;
  selected: boolean;
}) {
  const hydratedWorkspace = useSidebarWorkspaceEntry(workspace.serverId, workspace.workspaceId);

  if (!hydratedWorkspace) {
    return null;
  }

  return (
    <SidebarWorkspaceRow
      workspace={hydratedWorkspace}
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

function NewWorkspaceGhostRow({
  project,
  displayName,
  serverId,
  onWorkspacePress,
}: {
  project: SidebarProjectEntry;
  displayName: string;
  serverId: string | null;
  onWorkspacePress?: () => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    navigateToNewWorkspaceForProject({ serverId, project, displayName, onWorkspacePress });
  }, [displayName, onWorkspacePress, project, serverId]);
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.newWorkspaceGhostRow,
      (Boolean(hovered) || pressed) && styles.newWorkspaceGhostRowHovered,
    ],
    [],
  );

  return (
    <Pressable
      accessibilityRole={platformIsWeb ? undefined : "button"}
      accessibilityLabel={t("sidebar.workspace.actions.createWorkspaceFor", {
        projectName: displayName,
      })}
      onPress={handlePress}
      style={rowStyle}
      testID={`sidebar-project-new-workspace-row-${project.projectKey}`}
    >
      {({ hovered, pressed }) => (
        <>
          <View style={styles.newWorkspaceGhostIconSlot}>
            <ThemedPlus
              size={14}
              uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
            />
          </View>
          <Text
            style={
              hovered || pressed
                ? styles.newWorkspaceGhostTextHovered
                : styles.newWorkspaceGhostText
            }
            numberOfLines={1}
          >
            {t("sidebar.workspace.actions.newWorkspace")}
          </Text>
        </>
      )}
    </Pressable>
  );
}

function ProjectBlock({
  project,
  collapsed,
  displayName,
  iconDataUri,
  serverId,
  canRemoveProject,
  selectionEnabled,
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
  activeWorkspaceSelection,
}: {
  project: SidebarProjectEntry;
  collapsed: boolean;
  displayName: string;
  iconDataUri: string | null;
  serverId: string | null;
  canRemoveProject: boolean;
  selectionEnabled: boolean;
  showShortcutBadges: boolean;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  onToggleCollapsed: (projectKey: string) => void;
  onWorkspacePress?: () => void;
  onWorkspaceReorder: (projectKey: string, workspaces: SidebarWorkspaceEntry[]) => void;
  onWorktreeCreated?: (workspaceId: string) => void;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  useNestable: boolean;
  creatingWorkspaceIds: ReadonlySet<string>;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
}) {
  const rowModel = useMemo(
    () =>
      buildSidebarProjectRowModel({
        project,
        collapsed,
      }),
    [collapsed, project],
  );

  const active = isProjectSelectedByRoute({
    selection: activeWorkspaceSelection,
    serverId,
    project,
    enabled: selectionEnabled,
  });

  const renderWorkspaceRow = useCallback(
    (
      item: SidebarWorkspaceEntry,
      input?: {
        drag?: () => void;
        isDragging?: boolean;
        dragHandleProps?: DraggableListDragHandleProps;
      },
    ) => {
      return (
        <MemoWorkspaceRowItem
          workspace={item}
          shortcutNumber={shortcutIndexByWorkspaceKey.get(item.workspaceKey) ?? null}
          showShortcutBadge={showShortcutBadges}
          canCopyBranchName={project.projectKind === "git"}
          isCreating={creatingWorkspaceIds.has(item.workspaceId)}
          selectionEnabled={selectionEnabled}
          serverId={serverId}
          activeWorkspaceSelection={activeWorkspaceSelection}
          onWorkspacePress={onWorkspacePress}
          drag={input?.drag}
          isDragging={input?.isDragging}
          dragHandleProps={input?.dragHandleProps}
        />
      );
    },
    [
      project.projectKind,
      activeWorkspaceSelection,
      creatingWorkspaceIds,
      onWorkspacePress,
      serverId,
      selectionEnabled,
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
  const { t } = useTranslation();
  const [isRemovingProject, setIsRemovingProject] = useState(false);

  const handleRemoveProject = useCallback(() => {
    if (isRemovingProject || !serverId) {
      return;
    }

    void (async () => {
      const confirmed = await confirmDialog({
        title: t("sidebar.project.confirmations.removeTitle"),
        message: t("sidebar.project.confirmations.removeMessage", { projectName: displayName }),
        confirmLabel: t("sidebar.project.confirmations.removeConfirm"),
        cancelLabel: t("sidebar.project.confirmations.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) {
        toast.error(t("sidebar.project.toasts.hostDisconnected"));
        return;
      }
      if (!canRemoveProject) {
        toast.error(t("sidebar.project.toasts.updateHostToRemove"));
        return;
      }

      setIsRemovingProject(true);
      void client
        .removeProject(project.projectKey)
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("sidebar.project.toasts.removeFailed"),
          );
        })
        .finally(() => {
          setIsRemovingProject(false);
        });
    })();
  }, [isRemovingProject, serverId, displayName, t, toast, project.projectKey, canRemoveProject]);

  const handleToggleCollapsed = useCallback(() => {
    onToggleCollapsed(project.projectKey);
  }, [onToggleCollapsed, project.projectKey]);

  let projectChildren = null;
  if (!collapsed) {
    if (project.workspaces.length > 0) {
      projectChildren = (
        <DraggableList
          testID={`sidebar-workspace-list-${project.projectKey}`}
          data={project.workspaces}
          keyExtractor={workspaceKeyExtractor}
          renderItem={renderWorkspace}
          onDragEnd={handleWorkspaceDragEnd}
          extraData={activeWorkspaceSelectionKey(activeWorkspaceSelection)}
          scrollEnabled={false}
          useDragHandle
          nestable={useNestable}
          simultaneousGestureRef={parentGestureRef}
          containerStyle={styles.workspaceListContainer}
        />
      );
    } else {
      projectChildren = (
        <NewWorkspaceGhostRow
          project={project}
          displayName={displayName}
          serverId={serverId}
          onWorkspacePress={onWorkspacePress}
        />
      );
    }
  }

  return (
    <View style={styles.projectBlock}>
      <ProjectHeaderRow
        project={project}
        displayName={displayName}
        iconDataUri={iconDataUri}
        workspace={null}
        selected={false}
        chevron={rowModel.chevron}
        onPress={handleToggleCollapsed}
        serverId={serverId}
        canCreateWorktree={rowModel.trailingAction === "new_worktree"}
        isProjectActive={active}
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

      {projectChildren}
    </View>
  );
}

type ProjectBlockProps = Parameters<typeof ProjectBlock>[0];

function areProjectBlockPropsEqual(previous: ProjectBlockProps, next: ProjectBlockProps): boolean {
  return (
    previous.project === next.project &&
    previous.collapsed === next.collapsed &&
    previous.displayName === next.displayName &&
    previous.iconDataUri === next.iconDataUri &&
    previous.serverId === next.serverId &&
    previous.canRemoveProject === next.canRemoveProject &&
    previous.selectionEnabled === next.selectionEnabled &&
    previous.showShortcutBadges === next.showShortcutBadges &&
    previous.shortcutIndexByWorkspaceKey === next.shortcutIndexByWorkspaceKey &&
    previous.parentGestureRef === next.parentGestureRef &&
    previous.onToggleCollapsed === next.onToggleCollapsed &&
    previous.onWorkspacePress === next.onWorkspacePress &&
    previous.onWorkspaceReorder === next.onWorkspaceReorder &&
    previous.onWorktreeCreated === next.onWorktreeCreated &&
    previous.drag === next.drag &&
    previous.isDragging === next.isDragging &&
    previous.dragHandleProps === next.dragHandleProps &&
    previous.useNestable === next.useNestable &&
    previous.creatingWorkspaceIds === next.creatingWorkspaceIds &&
    areProjectBlockSelectionsEqual(previous, next)
  );
}

function areProjectBlockSelectionsEqual(
  previous: ProjectBlockProps,
  next: ProjectBlockProps,
): boolean {
  const previousActive = isProjectSelectedByRoute({
    selection: previous.activeWorkspaceSelection,
    project: previous.project,
    serverId: previous.serverId,
    enabled: previous.selectionEnabled,
  });
  const nextActive = isProjectSelectedByRoute({
    selection: next.activeWorkspaceSelection,
    project: next.project,
    serverId: next.serverId,
    enabled: next.selectionEnabled,
  });
  if (previousActive !== nextActive) {
    return false;
  }
  if (!previousActive) {
    return true;
  }
  return (
    activeWorkspaceSelectionKey(previous.activeWorkspaceSelection) ===
    activeWorkspaceSelectionKey(next.activeWorkspaceSelection)
  );
}

const MemoProjectBlock = memo(ProjectBlock, areProjectBlockPropsEqual);

export function SidebarWorkspaceList({
  projects,
  serverId,
  collapsedProjectKeys,
  onToggleProjectCollapsed,
  shortcutIndexByWorkspaceKey,
  groupMode,
  isRefreshing: _isRefreshing = false,
  onRefresh: _onRefresh,
  onWorkspacePress,
  onAddProject,
  listFooterComponent,
  parentGestureRef,
}: SidebarWorkspaceListProps) {
  const pathname = usePathname();

  if (groupMode === "status") {
    return (
      <SidebarStatusModeWrapper
        serverId={serverId}
        projects={projects}
        shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
        onWorkspacePress={onWorkspacePress}
      />
    );
  }

  return (
    <ProjectModeList
      projects={projects}
      serverId={serverId}
      collapsedProjectKeys={collapsedProjectKeys}
      onToggleProjectCollapsed={onToggleProjectCollapsed}
      shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
      onWorkspacePress={onWorkspacePress}
      onAddProject={onAddProject}
      listFooterComponent={listFooterComponent}
      parentGestureRef={parentGestureRef}
      pathname={pathname}
    />
  );
}

function SidebarStatusModeWrapper({
  serverId,
  projects,
  shortcutIndexByWorkspaceKey: _projectShortcutIndex,
  onWorkspacePress,
}: {
  serverId: string | null;
  projects: SidebarProjectEntry[];
  shortcutIndexByWorkspaceKey: Map<string, number>;
  onWorkspacePress?: () => void;
}) {
  const hydratedWorkspaces = useStatusModeWorkspaceEntries({
    serverId,
    projects,
  });
  const projectNamesByKey = useProjectNamesMap(serverId);
  const showShortcutBadges = useShowShortcutBadges();

  return (
    <SidebarStatusWorkspaceList
      workspaces={hydratedWorkspaces}
      projectNamesByKey={projectNamesByKey}
      serverId={serverId}
      shortcutIndexByWorkspaceKey={_projectShortcutIndex}
      showShortcutBadges={showShortcutBadges}
      onWorkspacePress={onWorkspacePress}
    />
  );
}

function ProjectModeList({
  projects,
  serverId,
  collapsedProjectKeys,
  onToggleProjectCollapsed,
  shortcutIndexByWorkspaceKey,
  onWorkspacePress,
  onAddProject,
  listFooterComponent,
  parentGestureRef,
  pathname,
}: Omit<SidebarWorkspaceListProps, "groupMode" | "isRefreshing" | "onRefresh"> & {
  pathname: string;
}) {
  const { t } = useTranslation();
  const [creatingWorkspaceIds, setCreatingWorkspaceIds] = useState<Set<string>>(() => new Set());
  const creatingWorkspaceTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const showShortcutBadges = useShowShortcutBadges();

  const getProjectOrder = useSidebarOrderStore((state) => state.getProjectOrder);
  const setProjectOrder = useSidebarOrderStore((state) => state.setProjectOrder);
  const getWorkspaceOrder = useSidebarOrderStore((state) => state.getWorkspaceOrder);
  const setWorkspaceOrder = useSidebarOrderStore((state) => state.setWorkspaceOrder);
  const canRemoveProject = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.serverInfo?.features?.projectRemove === true : false,
  );

  const isWorkspaceRoute = useMemo(
    () => Boolean(pathname && parseHostWorkspaceRouteFromPathname(pathname)),
    [pathname],
  );
  const selectionEnabled = isWorkspaceRoute;
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const nativeScrollGestureProps = useMemo(
    () =>
      parentGestureRef
        ? ({
            // NestableScrollContainer forwards props to RNGH ScrollView. Keep
            // vertical scroll and sidebar close pan simultaneous: vertical
            // intent scrolls immediately, clear horizontal intent can still
            // activate close from inside the list.
            simultaneousHandlers: parentGestureRef,
          } as object)
        : undefined,
    [parentGestureRef],
  );

  const projectIconByProjectKey = useProjectIconDataByProjectKey({
    serverId,
    projects,
  });

  useEffect(() => {
    const timeouts = creatingWorkspaceTimeoutsRef.current;
    return () => {
      for (const timeout of timeouts.values()) {
        clearTimeout(timeout);
      }
      timeouts.clear();
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

  const handleWorktreeCreated = useCallback((workspaceId: string) => {
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
  }, []);

  const renderProject = useCallback(
    ({ item, drag, isActive, dragHandleProps }: DraggableRenderItemInfo<SidebarProjectEntry>) => {
      return (
        <MemoProjectBlock
          project={item}
          collapsed={collapsedProjectKeys.has(item.projectKey)}
          displayName={item.projectName}
          iconDataUri={projectIconByProjectKey.get(item.projectKey) ?? null}
          serverId={serverId}
          canRemoveProject={canRemoveProject}
          selectionEnabled={selectionEnabled}
          showShortcutBadges={showShortcutBadges}
          shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
          parentGestureRef={parentGestureRef}
          onToggleCollapsed={onToggleProjectCollapsed}
          onWorkspacePress={onWorkspacePress}
          onWorkspaceReorder={handleWorkspaceReorder}
          onWorktreeCreated={handleWorktreeCreated}
          drag={drag}
          isDragging={isActive}
          dragHandleProps={dragHandleProps}
          useNestable={platformIsNative}
          creatingWorkspaceIds={creatingWorkspaceIds}
          activeWorkspaceSelection={activeWorkspaceSelection}
        />
      );
    },
    [
      collapsedProjectKeys,
      activeWorkspaceSelection,
      handleWorktreeCreated,
      handleWorkspaceReorder,
      onWorkspacePress,
      onToggleProjectCollapsed,
      parentGestureRef,
      projectIconByProjectKey,
      canRemoveProject,
      selectionEnabled,
      serverId,
      shortcutIndexByWorkspaceKey,
      showShortcutBadges,
      creatingWorkspaceIds,
    ],
  );

  const content = (
    <>
      {projects.length === 0 ? (
        <View style={styles.emptyContainer} testID="sidebar-project-empty-state">
          <Text style={styles.emptyTitle}>{t("sidebar.project.empty.title")}</Text>
          <Text style={styles.emptyText}>{t("sidebar.project.empty.description")}</Text>
          <Button variant="ghost" size="sm" leftIcon={Plus} onPress={onAddProject}>
            {t("sidebar.actions.addProject")}
          </Button>
        </View>
      ) : (
        <DraggableList
          testID="sidebar-project-list"
          data={projects}
          keyExtractor={projectKeyExtractor}
          renderItem={renderProject}
          onDragEnd={handleProjectDragEnd}
          extraData={activeWorkspaceSelectionKey(activeWorkspaceSelection)}
          scrollEnabled={false}
          useDragHandle
          nestable={platformIsNative}
          simultaneousGestureRef={parentGestureRef}
          containerStyle={styles.projectListContainer}
        />
      )}
      {listFooterComponent}
    </>
  );

  return (
    <View style={styles.container}>
      {platformIsNative ? (
        <NestableScrollContainer
          {...nativeScrollGestureProps}
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
  newWorkspaceGhostRow: {
    minHeight: 32,
    marginLeft: theme.spacing[6],
    marginRight: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  newWorkspaceGhostRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  newWorkspaceGhostIconSlot: {
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  newWorkspaceGhostText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    minWidth: 0,
    flexShrink: 1,
  },
  newWorkspaceGhostTextHovered: {
    fontSize: theme.fontSize.sm,
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
  },
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
    position: "relative",
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  projectRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
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
    alignItems: "center",
    justifyContent: "center",
  },
  projectIconFallbackText: {
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
    backgroundColor: theme.colors.surfaceSidebarHover,
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
  projectShortcutBadgeOverlay: {
    position: "absolute",
    top: theme.spacing[2] + 1,
    right: theme.spacing[2],
  },
  sidebarRowSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
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
  statusDotNeedsInput: {
    backgroundColor: theme.colors.palette.amber[500],
    borderColor: theme.colors.surface0,
  },
  statusDotFailed: {
    backgroundColor: theme.colors.palette.red[500],
    borderColor: theme.colors.surface0,
  },
  statusDotRunning: {
    backgroundColor: theme.colors.palette.blue[500],
    borderColor: theme.colors.surface0,
  },
  statusDotAttention: {
    backgroundColor: theme.colors.palette.green[500],
    borderColor: theme.colors.surface0,
  },
}));

function getStatusDotColorStyle(bucket: SidebarStateBucket): ViewStyle | null {
  switch (bucket) {
    case "needs_input":
      return styles.statusDotNeedsInput;
    case "failed":
      return styles.statusDotFailed;
    case "running":
      return styles.statusDotRunning;
    case "attention":
      return styles.statusDotAttention;
    case "done":
      return null;
  }
}
