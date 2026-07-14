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
import { AdaptiveRenameModal } from "@/components/rename-modal";
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
  Eye,
  EyeOff,
  Folder,
  FolderPlus,
  GitPullRequest,
  Settings,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from "lucide-react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import { DraggableList, type DraggableRenderItemInfo } from "./draggable-list";
import type { DraggableListDragHandleProps } from "./draggable-list.types";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import type { PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import {
  useSidebarWorkspacePinController,
  type ToggleSidebarWorkspacePin,
} from "@/hooks/use-sidebar-workspace-pin";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useProjectIconDataByProjectKey } from "@/projects/project-icons";
import {
  buildNewWorkspaceRoute,
  buildProjectSettingsRoute,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import {
  shouldShowSidebarHostLabels,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useShowShortcutBadges } from "@/hooks/use-show-shortcut-badges";
import { ContextMenuTrigger, useContextMenu } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { SyncedLoader } from "@/components/synced-loader";
import { useToast } from "@/contexts/toast-context";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";
import { confirmDialog } from "@/utils/confirm-dialog";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";
import { isEmphasizedStatusDotBucket } from "@/utils/status-dot-color";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { SidebarStatusWorkspaceList } from "@/components/sidebar/sidebar-status-list";
import type { StatusGroup } from "@/hooks/sidebar-status-view-model";
import { SidebarWorkspacePinProvider } from "@/components/sidebar/sidebar-workspace-menu";
import { PinnedSectionHeader } from "@/components/sidebar/pinned-section-header";
import { MemoSidebarWorkspaceRow } from "@/components/sidebar/sidebar-workspace-row";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import {
  SidebarWorkspaceSections,
  type SidebarWorkspaceSectionModel,
} from "@/components/sidebar/sidebar-workspace-sections";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";
import { SidebarWorkspaceShortcutBadge } from "@/components/sidebar/sidebar-workspace-row-content";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { PrHint } from "@/git/use-pr-status-query";
import {
  buildSidebarProjectRowModel,
  resolveSidebarProjectIconTarget,
  type SidebarProjectHostTarget,
} from "@/utils/sidebar-project-row-model";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  getCurrentProjectRemoveReadiness,
  removeProjectFromHosts,
} from "@/projects/project-remove";
import {
  isWeb as platformIsWeb,
  isNative as platformIsNative,
  getIsElectron,
} from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";
import { useSidebarWorkspaceVisibilityStore } from "@/stores/sidebar-workspace-visibility-store";
import { useSidebarProjectPreferencesStore } from "@/stores/sidebar-project-preferences-store";
import { selectUngroupedSidebarProjects } from "@/hooks/sidebar-workspace-organization";
import {
  normalizeWorkspaceCollection,
  useSessionStore,
  type WorkspaceDescriptor,
} from "@/stores/session-store";

const workspaceKeyExtractor = (workspace: SidebarWorkspacePlacement) => workspace.workspaceKey;

const projectKeyExtractor = (project: SidebarProjectEntry) => project.projectKey;
const EMPTY_WORKSPACE_SECTIONS: readonly SidebarWorkspaceSectionModel[] = [];

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
const ThemedPencil = withUnistyles(Pencil);
const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);
const ThemedFolder = withUnistyles(Folder);
const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedSettings = withUnistyles(Settings);
const ThemedEye = withUnistyles(Eye);
const ThemedEyeOff = withUnistyles(EyeOff);

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
  enabled: boolean;
}): boolean {
  return (
    input.enabled &&
    input.project.workspaces.some(
      (workspace) =>
        workspace.serverId === input.selection?.serverId &&
        workspace.workspaceId === input.selection.workspaceId,
    )
  );
}

function activeWorkspaceSelectionKey(selection: ActiveWorkspaceSelection | null): string {
  return selection ? `${selection.serverId}:${selection.workspaceId}` : "";
}

interface SidebarWorkspaceListProps {
  statusGroups: StatusGroup[];
  pinnedGroups: PinnedSidebarGroups;
  projects: SidebarProjectEntry[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByKey: Map<string, string>;
  collapsedProjectKeys: ReadonlySet<string>;
  onToggleProjectCollapsed: (projectKey: string) => void;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  groupMode: SidebarGroupMode;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  onWorkspacePress?: () => void;
  onAddProject?: () => void;
  listFooterComponent?: ReactElement | null;
  // Rendered inside the scroll area, below the Pinned section and above the workspace
  // list. Holds the "Workspaces" section header so pinned items sit above it.
  listHeaderComponent?: ReactElement | null;
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
  onPress?: () => void;
  worktreeTarget: SidebarProjectHostTarget | null;
  isProjectActive?: boolean;
  onWorkspacePress?: () => void;
  onWorktreeCreated?: (workspaceId: string) => void;
  shortcutNumber?: number | null;
  showShortcutBadge?: boolean;
  drag?: () => void;
  isDragging: boolean;
  isArchiving?: boolean;
  menuController: ReturnType<typeof useContextMenu> | null;
  onRemoveProject?: () => void;
  removeProjectStatus?: "idle" | "pending";
  dragHandleProps?: DraggableListDragHandleProps;
}

function getProjectHeaderDragBindings(
  enabled: boolean,
  dragHandleProps: DraggableListDragHandleProps | undefined,
) {
  if (!enabled) return {};

  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};
  return {
    ...dragAttributes,
    ...dragHandleProps?.listeners,
    ref: dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>,
  };
}

function getProjectHeaderInteractionBindings(
  enabled: boolean,
  interaction: ReturnType<typeof useLongPressDragInteraction>,
) {
  if (!enabled) return {};

  return {
    onPressIn: interaction.handlePressIn,
    onTouchMove: interaction.handleTouchMove,
    onPressOut: interaction.handlePressOut,
  };
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

function projectSectionKebabStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.projectKebabButton,
    platformIsNative && styles.nativeHeaderAction,
    hovered && styles.projectKebabButtonHovered,
  ];
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
  worktreeTarget,
  isHovered,
  isMobileBreakpoint,
  isProjectActive,
  onBeginWorkspaceSetup,
  onRemoveProject,
  removeProjectStatus,
}: {
  project: SidebarProjectEntry;
  displayName: string;
  worktreeTarget: SidebarProjectHostTarget | null;
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
      {(project.workspaceCount ?? project.workspaces.length) > 0 ? (
        <Text style={styles.projectWorkspaceCount}>
          {project.workspaceCount ?? project.workspaces.length}
        </Text>
      ) : null}
      {worktreeTarget ? (
        <NewWorktreeButton
          displayName={displayName}
          onPress={onBeginWorkspaceSetup}
          visible={actionsVisible}
          showShortcutHint={isProjectActive}
          testID={`sidebar-project-new-worktree-${project.projectKey}`}
        />
      ) : null}
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
    </View>
  );
}

const trash2LeadingIcon = <ThemedTrash2 size={14} uniProps={foregroundMutedColorMapping} />;
const pencilLeadingIcon = <ThemedPencil size={14} uniProps={foregroundMutedColorMapping} />;
const settingsLeadingIcon = <ThemedSettings size={14} uniProps={foregroundMutedColorMapping} />;
const openInNewWindowLeadingIcon = (
  <ThemedExternalLink size={14} uniProps={foregroundMutedColorMapping} />
);
const pinProjectLeadingIcon = <ThemedPin size={14} uniProps={foregroundMutedColorMapping} />;
const unpinProjectLeadingIcon = <ThemedPinOff size={14} uniProps={foregroundMutedColorMapping} />;
const hideProjectLeadingIcon = <ThemedEyeOff size={14} uniProps={foregroundMutedColorMapping} />;
const unhideProjectLeadingIcon = <ThemedEye size={14} uniProps={foregroundMutedColorMapping} />;
const projectCollectionLeadingIcon = (
  <ThemedFolder size={14} uniProps={foregroundMutedColorMapping} />
);
const newProjectCollectionLeadingIcon = (
  <ThemedFolderPlus size={14} uniProps={foregroundMutedColorMapping} />
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
  onRemoveProject?: () => void;
  removeProjectStatus: "idle" | "pending" | "success";
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [isCreateCollectionOpen, setIsCreateCollectionOpen] = useState(false);
  const stopTriggerPropagation = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);
  const isPinned = useSidebarProjectPreferencesStore((state) =>
    state.pinnedProjectKeys.includes(projectKey),
  );
  const isHidden = useSidebarWorkspaceVisibilityStore((state) =>
    state.hiddenProjectKeys.includes(projectKey),
  );
  const setProjectHidden = useSidebarWorkspaceVisibilityStore((state) => state.setProjectHidden);
  const collections = useSidebarProjectPreferencesStore((state) => state.collections);
  const assignedCollectionId = useSidebarProjectPreferencesStore(
    (state) => state.collectionIdByProjectKey[projectKey] ?? null,
  );
  const toggleProjectPinned = useSidebarProjectPreferencesStore(
    (state) => state.toggleProjectPinned,
  );
  const assignProjectToCollection = useSidebarProjectPreferencesStore(
    (state) => state.assignProjectToCollection,
  );
  const createCollection = useSidebarProjectPreferencesStore((state) => state.createCollection);
  const sortedCollections = useMemo(
    () =>
      [...collections].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
      ),
    [collections],
  );
  const handleTogglePin = useCallback(
    () => toggleProjectPinned(projectKey),
    [projectKey, toggleProjectPinned],
  );
  const handleToggleHidden = useCallback(
    () => setProjectHidden(projectKey, !isHidden),
    [isHidden, projectKey, setProjectHidden],
  );
  const handleClearCollection = useCallback(
    () => assignProjectToCollection(projectKey, null),
    [assignProjectToCollection, projectKey],
  );
  const handleCreateCollection = useCallback(
    (name: string) => {
      const collectionId = createCollection(name);
      assignProjectToCollection(projectKey, collectionId);
      setIsCreateCollectionOpen(false);
    },
    [assignProjectToCollection, createCollection, projectKey],
  );
  const handleOpenCreateCollection = useCallback(() => setIsCreateCollectionOpen(true), []);
  const handleCloseCreateCollection = useCallback(() => setIsCreateCollectionOpen(false), []);
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
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          hitSlop={8}
          onPress={stopTriggerPropagation}
          onPressIn={stopTriggerPropagation}
          style={projectKebabStyle}
          accessibilityRole={platformIsWeb ? undefined : "button"}
          accessibilityLabel={t("sidebar.project.actions.menu")}
          testID={`sidebar-project-kebab-${projectKey}`}
        >
          {renderKebabTriggerIcon}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={220}>
          <DropdownMenuItem
            testID={`sidebar-project-menu-pin-${projectKey}`}
            leading={isPinned ? unpinProjectLeadingIcon : pinProjectLeadingIcon}
            onSelect={handleTogglePin}
          >
            {t(
              isPinned ? "sidebar.organization.project.unpin" : "sidebar.organization.project.pin",
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            testID={`sidebar-project-menu-hide-${projectKey}`}
            leading={isHidden ? unhideProjectLeadingIcon : hideProjectLeadingIcon}
            onSelect={handleToggleHidden}
          >
            {t(
              isHidden
                ? "sidebar.organization.project.unhide"
                : "sidebar.organization.project.hide",
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            {t("sidebar.organization.project.moveToProjectGroup")}
          </DropdownMenuLabel>
          <DropdownMenuItem
            testID={`sidebar-project-menu-collection-none-${projectKey}`}
            leading={projectCollectionLeadingIcon}
            selected={assignedCollectionId === null}
            selectionRole="radio"
            onSelect={handleClearCollection}
          >
            {t("sidebar.organization.project.noProjectGroup")}
          </DropdownMenuItem>
          {sortedCollections.map((collection) => (
            <ProjectCollectionAssignmentItem
              key={collection.id}
              projectKey={projectKey}
              collectionId={collection.id}
              label={collection.name}
              selected={assignedCollectionId === collection.id}
              onAssign={assignProjectToCollection}
            />
          ))}
          <DropdownMenuItem
            testID={`sidebar-project-menu-new-collection-${projectKey}`}
            leading={newProjectCollectionLeadingIcon}
            onSelect={handleOpenCreateCollection}
          >
            {t("sidebar.organization.actions.newProjectGroup")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
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
          {onRemoveProject ? (
            <DropdownMenuItem
              testID={`sidebar-project-menu-remove-${projectKey}`}
              leading={trash2LeadingIcon}
              status={removeProjectStatus}
              pendingLabel={t("sidebar.project.actions.removing")}
              onSelect={onRemoveProject}
            >
              {t("sidebar.project.actions.remove")}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <AdaptiveRenameModal
        visible={isCreateCollectionOpen}
        title={t("sidebar.organization.projectGroup.modalTitle")}
        initialValue=""
        placeholder={t("sidebar.organization.projectGroup.placeholder")}
        submitLabel={t("sidebar.organization.actions.create")}
        onClose={handleCloseCreateCollection}
        onSubmit={handleCreateCollection}
        testID="sidebar-create-project-collection"
      />
    </>
  );
}

function ProjectCollectionAssignmentItem({
  projectKey,
  collectionId,
  label,
  selected,
  onAssign,
}: {
  projectKey: string;
  collectionId: string;
  label: string;
  selected: boolean;
  onAssign: (projectKey: string, collectionId: string | null) => void;
}): ReactElement {
  const handleAssign = useCallback(
    () => onAssign(projectKey, collectionId),
    [collectionId, onAssign, projectKey],
  );
  return (
    <DropdownMenuItem
      testID={`sidebar-project-menu-collection-${projectKey}-${collectionId}`}
      leading={projectCollectionLeadingIcon}
      selected={selected}
      selectionRole="radio"
      onSelect={handleAssign}
    >
      {label}
    </DropdownMenuItem>
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

function NewWorkspaceGhostRow({
  project,
  displayName,
  worktreeTarget,
  onWorkspacePress,
}: {
  project: SidebarProjectEntry;
  displayName: string;
  worktreeTarget: SidebarProjectHostTarget;
  onWorkspacePress?: () => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onWorkspacePress?.();
    router.navigate(
      buildNewWorkspaceRoute({
        serverId: worktreeTarget.serverId,
        sourceDirectory: worktreeTarget.iconWorkingDir,
        displayName,
        projectId: project.projectKey,
      }) as Href,
    );
  }, [displayName, onWorkspacePress, project.projectKey, worktreeTarget]);
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

function ProjectHeaderRow({
  project,
  displayName,
  iconDataUri,
  workspace,
  selected = false,
  chevron,
  onPress,
  worktreeTarget,
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
  const draggable = Boolean(drag);
  const interactionEnabled = draggable || Boolean(menuController);
  const handleBeginWorkspaceSetup = useCallback(() => {
    if (!worktreeTarget) {
      return;
    }
    onWorkspacePress?.();
    router.navigate(
      buildNewWorkspaceRoute({
        serverId: worktreeTarget.serverId,
        sourceDirectory: worktreeTarget.iconWorkingDir,
        displayName,
        projectId: project.projectKey,
      }) as Href,
    );
  }, [displayName, onWorkspacePress, project.projectKey, worktreeTarget]);
  const interaction = useLongPressDragInteraction({
    drag: drag ?? noop,
    menuController,
  });
  const accessibilityState = useMemo(
    () => (onPress && chevron ? { expanded: chevron === "collapse" } : undefined),
    [chevron, onPress],
  );
  const dragBindings = getProjectHeaderDragBindings(draggable, dragHandleProps);
  const interactionBindings = getProjectHeaderInteractionBindings(interactionEnabled, interaction);

  const handlePress = useCallback(() => {
    if (interactionEnabled && interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    onPress?.();
  }, [interaction.didLongPressRef, interactionEnabled, onPress]);

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const projectRowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.projectRow,
      isDragging && styles.projectRowDragging,
      selected && styles.sidebarRowSelected,
      isHovered && styles.projectRowHovered,
      onPress && pressed && styles.projectRowPressed,
    ],
    [isDragging, selected, isHovered, onPress],
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
          showChevron={chevron !== null && (isHovered || platformIsNative || isMobileBreakpoint)}
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
        worktreeTarget={worktreeTarget}
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
        {...dragBindings}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <ContextMenuTrigger
          enabledOnMobile={false}
          accessibilityRole={onPress ? "button" : undefined}
          accessibilityState={accessibilityState}
          style={projectRowStyle}
          {...interactionBindings}
          onPress={onPress ? handlePress : undefined}
          testID={`sidebar-project-row-${project.projectKey}`}
        >
          {rowChildren}
        </ContextMenuTrigger>
      </View>
    );
  }

  return (
    <View {...dragBindings} onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        accessibilityRole={onPress ? "button" : undefined}
        accessibilityState={accessibilityState}
        style={projectRowStyle}
        {...interactionBindings}
        onPress={onPress ? handlePress : undefined}
        testID={`sidebar-project-row-${project.projectKey}`}
      >
        {rowChildren}
      </Pressable>
    </View>
  );
}

interface WorkspaceRowItemProps {
  workspace: SidebarWorkspacePlacement;
  workspaceEntry: SidebarWorkspaceEntry | null;
  subtitle?: string | null;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  canCopyBranchName: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  reserveIdleStatusIndicatorSpace?: boolean;
  isCreating?: boolean;
  selectionEnabled: boolean;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  onWorkspacePress?: () => void;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

function WorkspaceRowItem({
  workspace,
  workspaceEntry,
  subtitle,
  shortcutNumber,
  showShortcutBadge,
  canCopyBranchName,
  canPin,
  onToggleWorkspacePin,
  reserveIdleStatusIndicatorSpace = true,
  isCreating = false,
  selectionEnabled,
  activeWorkspaceSelection,
  onWorkspacePress,
  drag,
  isDragging = false,
  dragHandleProps,
}: WorkspaceRowItemProps) {
  const handlePress = useCallback(() => {
    if (!workspace.serverId) {
      return;
    }
    onWorkspacePress?.();
    navigateToWorkspace({ serverId: workspace.serverId, workspaceId: workspace.workspaceId });
  }, [onWorkspacePress, workspace.serverId, workspace.workspaceId]);

  if (!workspaceEntry) {
    return null;
  }

  return (
    <MemoSidebarWorkspaceRow
      workspace={workspaceEntry}
      subtitle={subtitle}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      canCopyBranchName={canCopyBranchName}
      canPin={canPin}
      onToggleWorkspacePin={onToggleWorkspacePin}
      reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
      isCreating={isCreating}
      selected={isWorkspaceSelected({
        selection: activeWorkspaceSelection,
        serverId: workspace.serverId,
        workspaceId: workspace.workspaceId,
        enabled: selectionEnabled,
      })}
      onPress={handlePress}
      drag={drag}
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
    previous.workspaceEntry === next.workspaceEntry &&
    previous.subtitle === next.subtitle &&
    previous.shortcutNumber === next.shortcutNumber &&
    previous.showShortcutBadge === next.showShortcutBadge &&
    previous.canCopyBranchName === next.canCopyBranchName &&
    previous.canPin === next.canPin &&
    previous.onToggleWorkspacePin === next.onToggleWorkspacePin &&
    previous.reserveIdleStatusIndicatorSpace === next.reserveIdleStatusIndicatorSpace &&
    previous.isCreating === next.isCreating &&
    previous.onWorkspacePress === next.onWorkspacePress &&
    previous.drag === next.drag &&
    previous.isDragging === next.isDragging &&
    previous.dragHandleProps === next.dragHandleProps &&
    previousSelected === nextSelected
  );
}

const MemoWorkspaceRowItem = memo(WorkspaceRowItem, areWorkspaceRowItemPropsEqual);

function ProjectBlock({
  project,
  workspaceEntriesByKey,
  collapsed,
  displayName,
  iconDataUri,
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
  hostLabelByServerId,
  showHostLabels,
  supportsMultiplicityByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  projectDragEnabled,
  workspaceDragEnabled,
  hideWorkspaceRows = false,
}: {
  project: SidebarProjectEntry;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  collapsed: boolean;
  displayName: string;
  iconDataUri: string | null;
  selectionEnabled: boolean;
  showShortcutBadges: boolean;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  onToggleCollapsed: (projectKey: string) => void;
  onWorkspacePress?: () => void;
  onWorkspaceReorder: (projectKey: string, workspaces: SidebarWorkspacePlacement[]) => void;
  onWorktreeCreated?: (workspaceId: string) => void;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  useNestable: boolean;
  creatingWorkspaceIds: ReadonlySet<string>;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  hostLabelByServerId: ReadonlyMap<string, string>;
  showHostLabels: boolean;
  supportsMultiplicityByServerId: ReadonlyMap<string, boolean>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  projectDragEnabled: boolean;
  workspaceDragEnabled: boolean;
  hideWorkspaceRows?: boolean;
}) {
  const rowModel = useMemo(
    () =>
      buildSidebarProjectRowModel({
        project,
        collapsed,
        supportsMultiplicityByServerId,
      }),
    [collapsed, project, supportsMultiplicityByServerId],
  );

  const active = isProjectSelectedByRoute({
    selection: activeWorkspaceSelection,
    project,
    enabled: selectionEnabled,
  });

  const renderWorkspaceRow = useCallback(
    (
      item: SidebarWorkspacePlacement,
      input?: {
        drag?: () => void;
        isDragging?: boolean;
        dragHandleProps?: DraggableListDragHandleProps;
      },
    ) => {
      return (
        <MemoWorkspaceRowItem
          workspace={item}
          workspaceEntry={workspaceEntriesByKey.get(item.workspaceKey) ?? null}
          subtitle={
            showHostLabels ? (hostLabelByServerId.get(item.serverId) ?? item.serverId) : null
          }
          shortcutNumber={shortcutIndexByWorkspaceKey.get(item.workspaceKey) ?? null}
          showShortcutBadge={showShortcutBadges}
          canCopyBranchName={project.projectKind === "git"}
          canPin={supportsPinningByServerId.get(item.serverId) === true}
          onToggleWorkspacePin={onToggleWorkspacePin}
          isCreating={creatingWorkspaceIds.has(item.workspaceId)}
          selectionEnabled={selectionEnabled}
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
      onToggleWorkspacePin,
      supportsPinningByServerId,
      showHostLabels,
      activeWorkspaceSelection,
      creatingWorkspaceIds,
      hostLabelByServerId,
      onWorkspacePress,
      selectionEnabled,
      shortcutIndexByWorkspaceKey,
      showShortcutBadges,
      workspaceEntriesByKey,
    ],
  );

  const renderWorkspace = useCallback(
    ({
      item,
      drag: workspaceDrag,
      isActive,
      dragHandleProps: workspaceDragHandleProps,
    }: DraggableRenderItemInfo<SidebarWorkspacePlacement>) => {
      return renderWorkspaceRow(item, {
        drag: workspaceDrag,
        isDragging: isActive,
        dragHandleProps: workspaceDragHandleProps,
      });
    },
    [renderWorkspaceRow],
  );

  const handleWorkspaceDragEnd = useCallback(
    (workspaces: SidebarWorkspacePlacement[]) => {
      onWorkspaceReorder(project.projectKey, workspaces);
    },
    [onWorkspaceReorder, project.projectKey],
  );

  const toast = useToast();
  const { t } = useTranslation();
  const [isRemovingProject, setIsRemovingProject] = useState(false);

  const handleRemoveProject = useCallback(() => {
    if (isRemovingProject) {
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

      setIsRemovingProject(true);
      const readiness = getCurrentProjectRemoveReadiness({
        projectKey: project.projectKey,
        hosts: project.hosts,
      });
      if (readiness.kind === "needs_host_update") {
        toast.error(t("sidebar.project.toasts.updateHostToRemove"));
        setIsRemovingProject(false);
        return;
      }

      void removeProjectFromHosts({
        projectKey: project.projectKey,
        targets: readiness.targets,
        getClient: (serverId) => getHostRuntimeStore().getClient(serverId),
      })
        .then((outcome) => {
          if (outcome.kind === "host_disconnected") {
            toast.error(t("sidebar.project.toasts.hostDisconnected"));
            return null;
          }
          if (outcome.kind === "failed") {
            toast.error(t("sidebar.project.toasts.removeFailed"));
          }
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("sidebar.project.toasts.removeFailed"),
          );
        })
        .finally(() => {
          setIsRemovingProject(false);
        });
    })();
  }, [isRemovingProject, displayName, t, toast, project.projectKey, project.hosts]);

  const handleToggleCollapsed = useCallback(() => {
    onToggleCollapsed(project.projectKey);
  }, [onToggleCollapsed, project.projectKey]);

  let projectChildren = null;
  if (!collapsed && !hideWorkspaceRows) {
    if (project.workspaces.length > 0) {
      projectChildren = workspaceDragEnabled ? (
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
      ) : (
        <View style={styles.workspaceListContainer}>
          {project.workspaces.map((workspace) => (
            <View key={workspace.workspaceKey}>{renderWorkspaceRow(workspace)}</View>
          ))}
        </View>
      );
    } else if (rowModel.trailingAction.kind === "new_workspace") {
      projectChildren = (
        <NewWorkspaceGhostRow
          project={project}
          displayName={displayName}
          worktreeTarget={rowModel.trailingAction.target}
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
        chevron={hideWorkspaceRows ? null : rowModel.chevron}
        onPress={hideWorkspaceRows ? undefined : handleToggleCollapsed}
        worktreeTarget={
          rowModel.trailingAction.kind === "new_workspace" ? rowModel.trailingAction.target : null
        }
        isProjectActive={active}
        onWorkspacePress={onWorkspacePress}
        onWorktreeCreated={onWorktreeCreated}
        drag={projectDragEnabled ? drag : undefined}
        isDragging={isDragging}
        isArchiving={isRemovingProject}
        menuController={null}
        onRemoveProject={handleRemoveProject}
        removeProjectStatus={isRemovingProject ? "pending" : "idle"}
        dragHandleProps={projectDragEnabled ? dragHandleProps : undefined}
      />

      {projectChildren}
    </View>
  );
}

type ProjectBlockProps = Parameters<typeof ProjectBlock>[0];

// oxlint-disable-next-line complexity
function areProjectBlockPropsEqual(previous: ProjectBlockProps, next: ProjectBlockProps): boolean {
  return (
    previous.project === next.project &&
    previous.workspaceEntriesByKey === next.workspaceEntriesByKey &&
    previous.collapsed === next.collapsed &&
    previous.displayName === next.displayName &&
    previous.iconDataUri === next.iconDataUri &&
    previous.selectionEnabled === next.selectionEnabled &&
    previous.showShortcutBadges === next.showShortcutBadges &&
    previous.shortcutIndexByWorkspaceKey === next.shortcutIndexByWorkspaceKey &&
    previous.hostLabelByServerId === next.hostLabelByServerId &&
    previous.showHostLabels === next.showHostLabels &&
    previous.supportsMultiplicityByServerId === next.supportsMultiplicityByServerId &&
    previous.supportsPinningByServerId === next.supportsPinningByServerId &&
    previous.onToggleWorkspacePin === next.onToggleWorkspacePin &&
    previous.parentGestureRef === next.parentGestureRef &&
    previous.onToggleCollapsed === next.onToggleCollapsed &&
    previous.onWorkspacePress === next.onWorkspacePress &&
    previous.onWorkspaceReorder === next.onWorkspaceReorder &&
    previous.onWorktreeCreated === next.onWorktreeCreated &&
    previous.drag === next.drag &&
    previous.isDragging === next.isDragging &&
    previous.dragHandleProps === next.dragHandleProps &&
    previous.useNestable === next.useNestable &&
    previous.projectDragEnabled === next.projectDragEnabled &&
    previous.workspaceDragEnabled === next.workspaceDragEnabled &&
    previous.hideWorkspaceRows === next.hideWorkspaceRows &&
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
    enabled: previous.selectionEnabled,
  });
  const nextActive = isProjectSelectedByRoute({
    selection: next.activeWorkspaceSelection,
    project: next.project,
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

const HiddenProjectsSection = memo(function HiddenProjectsSection({
  projects,
  onUnhideAll,
}: {
  projects: readonly SidebarProjectEntry[];
  onUnhideAll: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (projects.length === 0) return null;
  return (
    <View style={styles.hiddenProjectsSection} testID="sidebar-hidden-projects-section">
      <View style={styles.hiddenProjectsHeader}>
        <View style={styles.hiddenProjectsIdentity}>
          <ThemedFolder size={14} uniProps={foregroundMutedColorMapping} />
          <Text style={styles.hiddenProjectsLabel}>
            {t("sidebar.organization.hiddenProjects.title")}
          </Text>
          <Text style={styles.projectSectionCount}>· {projects.length}</Text>
        </View>
        <Button
          variant="ghost"
          size="xs"
          style={platformIsNative ? styles.nativeHeaderAction : undefined}
          onPress={onUnhideAll}
        >
          {t("sidebar.organization.hiddenProjects.unhideAll")}
        </Button>
      </View>
      {projects.map((project) => (
        <View
          key={project.projectKey}
          style={styles.hiddenProjectRow}
          testID={`sidebar-hidden-project-${project.projectKey}`}
        >
          <ThemedFolder size={16} uniProps={foregroundMutedColorMapping} />
          <Text numberOfLines={1} style={styles.hiddenProjectName}>
            {project.projectName}
          </Text>
          {(project.workspaceCount ?? project.workspaces.length) > 0 ? (
            <Text style={styles.projectWorkspaceCount}>
              {project.workspaceCount ?? project.workspaces.length}
            </Text>
          ) : null}
          <ProjectKebabMenu
            projectKey={project.projectKey}
            projectPath={project.iconWorkingDir}
            removeProjectStatus="idle"
          />
        </View>
      ))}
    </View>
  );
});

export function SidebarWorkspaceList({
  statusGroups,
  pinnedGroups,
  projects,
  workspaceEntriesByKey,
  projectNamesByKey,
  collapsedProjectKeys,
  onToggleProjectCollapsed,
  shortcutIndexByWorkspaceKey,
  groupMode,
  isRefreshing: _isRefreshing = false,
  onRefresh: _onRefresh,
  onWorkspacePress,
  onAddProject,
  listFooterComponent,
  listHeaderComponent,
  parentGestureRef,
}: SidebarWorkspaceListProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [renamingCollection, setRenamingCollection] = useState<{
    serverId: string;
    collectionId: string;
    name: string;
  } | null>(null);
  const pathname = usePathname();
  const hosts = useHosts();
  const {
    pinnedProjects,
    hiddenProjects,
    hiddenRows,
    ungroupedRows,
    collectionGroups,
    hiddenSectionCollapsed,
    collapsedCollectionKeys,
    toggleHiddenSectionCollapsed,
    toggleCollectionCollapsed,
  } = useSidebarModel();
  const visibilityFilter = useSidebarViewStore((state) => state.visibilityFilter);
  const setVisibilityFilter = useSidebarViewStore((state) => state.setVisibilityFilter);
  const unhideAll = useSidebarWorkspaceVisibilityStore((state) => state.unhideAll);
  const showShortcutBadges = useShowShortcutBadges();
  const hostLabelByServerId = useMemo(() => {
    const labels = new Map<string, string>();
    for (const host of hosts) {
      labels.set(host.serverId, host.label?.trim() || host.serverId);
    }
    return labels;
  }, [hosts]);
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const supportsMultiplicityByServerId = useHostFeatureMap(serverIds, "workspaceMultiplicity");
  const supportsPinningByServerId = useHostFeatureMap(serverIds, "workspacePinning");
  const onToggleWorkspacePin = useSidebarWorkspacePinController();
  const visibleProjects = useMemo(
    () => [...pinnedProjects, ...projects],
    [pinnedProjects, projects],
  );
  const showHostLabels = useMemo(
    () =>
      shouldShowSidebarHostLabels(
        visibleProjects,
        hiddenRows.map((workspace) => workspace.serverId),
      ),
    [hiddenRows, visibleProjects],
  );
  const hiddenSections = useMemo<SidebarWorkspaceSectionModel[]>(
    () =>
      hiddenRows.length > 0
        ? [
            {
              key: "hidden",
              label: t("sidebar.organization.sections.hidden"),
              rows: hiddenRows,
              collapsed: visibilityFilter === "hidden" ? false : hiddenSectionCollapsed,
              onToggle: toggleHiddenSectionCollapsed,
              onClear: unhideAll,
            },
          ]
        : [],
    [
      hiddenRows,
      hiddenSectionCollapsed,
      t,
      toggleHiddenSectionCollapsed,
      unhideAll,
      visibilityFilter,
    ],
  );
  const renderOrganizationSections = useCallback(
    (sections: readonly SidebarWorkspaceSectionModel[], showHeaders = true) => (
      <SidebarWorkspaceSections
        sections={sections}
        shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
        showShortcutBadges={showShortcutBadges}
        projectNamesByKey={projectNamesByKey}
        hostLabelByServerId={hostLabelByServerId}
        showHostLabels={showHostLabels}
        supportsPinningByServerId={supportsPinningByServerId}
        onToggleWorkspacePin={onToggleWorkspacePin}
        onWorkspacePress={onWorkspacePress}
        showHeaders={showHeaders}
      />
    ),
    [
      hostLabelByServerId,
      onWorkspacePress,
      projectNamesByKey,
      shortcutIndexByWorkspaceKey,
      showHostLabels,
      showShortcutBadges,
      supportsPinningByServerId,
      onToggleWorkspacePin,
    ],
  );
  const renderOrganizationHeader = useCallback(() => {
    if (pinnedGroups.pinnedChats.length === 0) return null;
    return (
      <PinnedChatsSection
        pinnedChats={pinnedGroups.pinnedChats}
        workspaceEntriesByKey={workspaceEntriesByKey}
        shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
        showShortcutBadges={showShortcutBadges}
        supportsPinningByServerId={supportsPinningByServerId}
        onToggleWorkspacePin={onToggleWorkspacePin}
        onWorkspacePress={onWorkspacePress}
      />
    );
  }, [
    onToggleWorkspacePin,
    onWorkspacePress,
    pinnedGroups.pinnedChats,
    shortcutIndexByWorkspaceKey,
    showShortcutBadges,
    supportsPinningByServerId,
    workspaceEntriesByKey,
  ]);
  const organizationFooter = (
    <>
      <HiddenProjectsSection projects={hiddenProjects} onUnhideAll={unhideAll} />
      {renderOrganizationSections(hiddenSections)}
    </>
  );
  const handleRenameCollection = useCallback(
    async (name: string) => {
      if (!renamingCollection) return;
      const client = getHostRuntimeStore().getClient(renamingCollection.serverId);
      if (!client) throw new Error(t("sidebar.organization.errors.hostDisconnected"));
      const collection = await client.renameWorkspaceCollection(
        renamingCollection.collectionId,
        name.trim(),
      );
      const sessionCollections =
        useSessionStore.getState().sessions[renamingCollection.serverId]?.workspaceCollections;
      useSessionStore
        .getState()
        .setWorkspaceCollections(renamingCollection.serverId, [
          ...Array.from(sessionCollections?.values() ?? []).filter(
            (existing) => existing.id !== collection.id,
          ),
          normalizeWorkspaceCollection(collection),
        ]);
      setRenamingCollection(null);
    },
    [renamingCollection, t],
  );
  const handleDeleteCollection = useCallback(
    (serverId: string, collectionId: string, name: string) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("sidebar.organization.workspaceLabel.delete"),
          message: t("sidebar.organization.workspaceLabel.deleteMessage", { name }),
          confirmLabel: t("sidebar.organization.workspaceLabel.delete"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (!confirmed) return;
        const client = getHostRuntimeStore().getClient(serverId);
        if (!client) throw new Error(t("sidebar.organization.errors.hostDisconnected"));
        await client.deleteWorkspaceCollection(collectionId);
        const session = useSessionStore.getState().sessions[serverId];
        useSessionStore.getState().setWorkspaceCollections(
          serverId,
          Array.from(session?.workspaceCollections.values() ?? []).filter(
            (collection) => collection.id !== collectionId,
          ),
        );
        updateWorkspaceCollectionAssignments(serverId, collectionId);
      })().catch((error) => {
        toast.error(
          error instanceof Error
            ? error.message
            : t("sidebar.organization.errors.deleteWorkspaceLabelFailed"),
        );
      });
    },
    [t, toast],
  );
  const handleCloseRenameCollection = useCallback(() => setRenamingCollection(null), []);
  const collectionSectionModels = useMemo<SidebarWorkspaceSectionModel[]>(
    () =>
      collectionGroups.map((group) => {
        const serverId = group.serverId;
        const collectionId = group.collectionId;
        const displayLabel =
          showHostLabels && serverId
            ? `${group.label} · ${hostLabelByServerId.get(serverId) ?? serverId}`
            : group.label;
        const onToggle = () => toggleCollectionCollapsed(group.key);
        if (!serverId || !collectionId) {
          return {
            key: `collection-${group.key}`,
            label: displayLabel,
            markerKey: group.key,
            rows: group.rows,
            collapsed: collapsedCollectionKeys.has(group.key),
            onToggle,
          };
        }
        return {
          key: `collection-${group.key}`,
          label: displayLabel,
          markerKey: `${serverId}:${collectionId}`,
          rows: group.rows,
          collapsed: collapsedCollectionKeys.has(group.key),
          onToggle,
          onRename: () => setRenamingCollection({ serverId, collectionId, name: group.label }),
          onDelete: () => handleDeleteCollection(serverId, collectionId, group.label),
        };
      }),
    [
      collapsedCollectionKeys,
      collectionGroups,
      handleDeleteCollection,
      hostLabelByServerId,
      showHostLabels,
      toggleCollectionCollapsed,
    ],
  );
  const ungroupedSections = useMemo<SidebarWorkspaceSectionModel[]>(
    () => [
      {
        key: "all",
        label: t("sidebar.organization.sections.workspaces"),
        rows: ungroupedRows,
      },
    ],
    [t, ungroupedRows],
  );

  const showHiddenEmptyState =
    visibilityFilter === "hidden" && hiddenProjects.length === 0 && hiddenRows.length === 0;
  const handleShowVisibleItems = useCallback(
    () => setVisibilityFilter("visible"),
    [setVisibilityFilter],
  );

  let content: ReactElement;
  if (showHiddenEmptyState) {
    content = (
      <WorkspaceOrganizationModeList
        headerSections={EMPTY_WORKSPACE_SECTIONS}
        groupedSections={EMPTY_WORKSPACE_SECTIONS}
        organizationFooter={null}
        renderSections={renderOrganizationSections}
        showGroupedHeaders={false}
        listHeaderComponent={listHeaderComponent}
        listFooterComponent={
          <>
            <View style={styles.emptyContainer} testID="sidebar-hidden-empty-state">
              <Text style={styles.emptyTitle}>
                {t("sidebar.organization.hiddenProjects.empty")}
              </Text>
              <Text style={styles.emptyText}>
                {t("sidebar.organization.hiddenProjects.description")}
              </Text>
              <Button variant="ghost" size="sm" onPress={handleShowVisibleItems}>
                {t("sidebar.organization.hiddenProjects.showVisible")}
              </Button>
            </View>
            {listFooterComponent}
          </>
        }
        parentGestureRef={parentGestureRef}
      />
    );
  } else if (groupMode === "status") {
    content = (
      <SidebarStatusModeWrapper
        statusGroups={statusGroups}
        pinnedGroups={pinnedGroups}
        workspaceEntriesByKey={workspaceEntriesByKey}
        projectNamesByKey={projectNamesByKey}
        shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
        onWorkspacePress={onWorkspacePress}
        hostLabelByServerId={hostLabelByServerId}
        showHostLabels={showHostLabels}
        supportsPinningByServerId={supportsPinningByServerId}
        onToggleWorkspacePin={onToggleWorkspacePin}
        listHeaderComponent={listHeaderComponent}
        listFooterComponent={organizationFooter}
      />
    );
  } else if (groupMode === "project" || groupMode === "project_collection") {
    content = (
      <ProjectModeList
        pinnedProjects={pinnedProjects}
        groupProjectsByCollection={groupMode === "project_collection"}
        projectHeadersOnly={false}
        suppressEmptyState={visibilityFilter === "hidden" && hiddenProjects.length > 0}
        middleContent={null}
        projects={projects}
        workspaceEntriesByKey={workspaceEntriesByKey}
        collapsedProjectKeys={collapsedProjectKeys}
        onToggleProjectCollapsed={onToggleProjectCollapsed}
        shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
        onWorkspacePress={onWorkspacePress}
        onAddProject={onAddProject}
        listFooterComponent={listFooterComponent}
        listHeaderComponent={listHeaderComponent}
        parentGestureRef={parentGestureRef}
        pathname={pathname}
        hostLabelByServerId={hostLabelByServerId}
        showHostLabels={showHostLabels}
        supportsMultiplicityByServerId={supportsMultiplicityByServerId}
        supportsPinningByServerId={supportsPinningByServerId}
        onToggleWorkspacePin={onToggleWorkspacePin}
        renderOrganizationHeader={renderOrganizationHeader}
        organizationFooter={organizationFooter}
      />
    );
  } else {
    const ungroupedProjects = selectUngroupedSidebarProjects({
      pinnedProjects,
      projects,
    });
    const showUngroupedProjectRows =
      groupMode === "none" &&
      visibilityFilter !== "hidden" &&
      ungroupedProjects.pinnedProjects.length + ungroupedProjects.projects.length > 0;
    if (showUngroupedProjectRows) {
      content = (
        <ProjectModeList
          pinnedProjects={ungroupedProjects.pinnedProjects}
          groupProjectsByCollection={false}
          projectHeadersOnly
          suppressEmptyState={false}
          middleContent={renderOrganizationSections(ungroupedSections, false)}
          projects={ungroupedProjects.projects}
          workspaceEntriesByKey={workspaceEntriesByKey}
          collapsedProjectKeys={collapsedProjectKeys}
          onToggleProjectCollapsed={onToggleProjectCollapsed}
          shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
          onWorkspacePress={onWorkspacePress}
          onAddProject={onAddProject}
          listFooterComponent={listFooterComponent}
          parentGestureRef={parentGestureRef}
          pathname={pathname}
          hostLabelByServerId={hostLabelByServerId}
          showHostLabels={showHostLabels}
          supportsMultiplicityByServerId={supportsMultiplicityByServerId}
          supportsPinningByServerId={supportsPinningByServerId}
          onToggleWorkspacePin={onToggleWorkspacePin}
          renderOrganizationHeader={renderOrganizationHeader}
          organizationFooter={organizationFooter}
        />
      );
    } else {
      const groupedSections =
        groupMode === "collection" ? collectionSectionModels : ungroupedSections;
      content = (
        <WorkspaceOrganizationModeList
          headerSections={EMPTY_WORKSPACE_SECTIONS}
          groupedSections={groupedSections}
          renderOrganizationHeader={renderOrganizationHeader}
          organizationFooter={organizationFooter}
          renderSections={renderOrganizationSections}
          showGroupedHeaders={groupMode === "collection"}
          listHeaderComponent={listHeaderComponent}
          listFooterComponent={listFooterComponent}
          parentGestureRef={parentGestureRef}
        />
      );
    }
  }

  return (
    <SidebarWorkspacePinProvider
      supportsPinningByServerId={supportsPinningByServerId}
      onToggleWorkspacePin={onToggleWorkspacePin}
    >
      {content}
      <AdaptiveRenameModal
        visible={renamingCollection !== null}
        title={t("sidebar.organization.workspaceLabel.renameTitle")}
        initialValue={renamingCollection?.name ?? ""}
        placeholder={t("sidebar.organization.workspaceLabel.placeholder")}
        submitLabel={t("renameModal.rename")}
        onClose={handleCloseRenameCollection}
        onSubmit={handleRenameCollection}
        testID="sidebar-rename-collection"
      />
    </SidebarWorkspacePinProvider>
  );
}

function updateWorkspaceCollectionAssignments(serverId: string, collectionId: string): void {
  useSessionStore.getState().setWorkspaces(serverId, (current) => {
    let changed = false;
    const next = new Map<string, WorkspaceDescriptor>();
    for (const [workspaceId, workspace] of current) {
      if (workspace.collectionId !== collectionId) {
        next.set(workspaceId, workspace);
        continue;
      }
      changed = true;
      next.set(workspaceId, { ...workspace, collectionId: null });
    }
    return changed ? next : current;
  });
}

function SidebarStatusModeWrapper({
  statusGroups,
  pinnedGroups,
  workspaceEntriesByKey,
  projectNamesByKey,
  shortcutIndexByWorkspaceKey: _projectShortcutIndex,
  onWorkspacePress,
  hostLabelByServerId,
  showHostLabels,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  listHeaderComponent,
  listFooterComponent,
}: {
  statusGroups: StatusGroup[];
  pinnedGroups: PinnedSidebarGroups;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByKey: Map<string, string>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  onWorkspacePress?: () => void;
  hostLabelByServerId: ReadonlyMap<string, string>;
  showHostLabels: boolean;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  listHeaderComponent?: ReactElement | null;
  listFooterComponent?: ReactElement | null;
}) {
  const showShortcutBadges = useShowShortcutBadges();

  return (
    <SidebarStatusWorkspaceList
      groups={statusGroups}
      pinnedWorkspaces={pinnedGroups.pinnedChats.flatMap((workspace) => {
        const entry = workspaceEntriesByKey.get(workspace.workspaceKey);
        return entry ? [entry] : [];
      })}
      projectNamesByKey={projectNamesByKey}
      shortcutIndexByWorkspaceKey={_projectShortcutIndex}
      showShortcutBadges={showShortcutBadges}
      onWorkspacePress={onWorkspacePress}
      hostLabelByServerId={hostLabelByServerId}
      showHostLabels={showHostLabels}
      supportsPinningByServerId={supportsPinningByServerId}
      onToggleWorkspacePin={onToggleWorkspacePin}
      listHeaderComponent={listHeaderComponent}
      listFooterComponent={listFooterComponent}
    />
  );
}

function PinnedChatsSection({
  pinnedChats,
  workspaceEntriesByKey,
  shortcutIndexByWorkspaceKey,
  showShortcutBadges,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  onWorkspacePress,
}: {
  pinnedChats: PinnedSidebarGroups["pinnedChats"];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  shortcutIndexByWorkspaceKey: ReadonlyMap<string, number>;
  showShortcutBadges: boolean;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  onWorkspacePress?: () => void;
}): ReactElement {
  const pathname = usePathname();
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const togglePinnedCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.togglePinnedCollapsed,
  );
  const selectionEnabled = Boolean(pathname && parseHostWorkspaceRouteFromPathname(pathname));
  const renderPinnedChat = useCallback(
    (workspace: SidebarWorkspacePlacement) => {
      return (
        <MemoWorkspaceRowItem
          key={workspace.workspaceKey}
          workspace={workspace}
          workspaceEntry={workspaceEntriesByKey.get(workspace.workspaceKey) ?? null}
          subtitle={null}
          shortcutNumber={shortcutIndexByWorkspaceKey.get(workspace.workspaceKey) ?? null}
          showShortcutBadge={showShortcutBadges}
          canCopyBranchName={workspace.projectKind === "git"}
          canPin={supportsPinningByServerId.get(workspace.serverId) === true}
          onToggleWorkspacePin={onToggleWorkspacePin}
          reserveIdleStatusIndicatorSpace={false}
          selectionEnabled={selectionEnabled}
          activeWorkspaceSelection={activeWorkspaceSelection}
          onWorkspacePress={onWorkspacePress}
        />
      );
    },
    [
      activeWorkspaceSelection,
      onToggleWorkspacePin,
      onWorkspacePress,
      selectionEnabled,
      shortcutIndexByWorkspaceKey,
      showShortcutBadges,
      supportsPinningByServerId,
      workspaceEntriesByKey,
    ],
  );

  return (
    <View style={styles.pinnedSection} testID="sidebar-pinned-section">
      <PinnedSectionHeader collapsed={pinnedCollapsed} onToggle={togglePinnedCollapsed} />
      {pinnedCollapsed ? null : pinnedChats.map(renderPinnedChat)}
    </View>
  );
}

function WorkspaceOrganizationModeList({
  headerSections,
  groupedSections,
  renderOrganizationHeader,
  organizationFooter,
  renderSections,
  showGroupedHeaders,
  listHeaderComponent,
  listFooterComponent,
  parentGestureRef,
}: {
  headerSections: readonly SidebarWorkspaceSectionModel[];
  groupedSections: readonly SidebarWorkspaceSectionModel[];
  renderOrganizationHeader?: () => ReactElement | null;
  organizationFooter: ReactElement | null;
  renderSections: (
    sections: readonly SidebarWorkspaceSectionModel[],
    showHeaders?: boolean,
  ) => ReactElement;
  showGroupedHeaders: boolean;
  listHeaderComponent?: ReactElement | null;
  listFooterComponent?: ReactElement | null;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
}) {
  const nativeScrollGestureProps = useMemo(
    () => (parentGestureRef ? ({ simultaneousHandlers: parentGestureRef } as object) : undefined),
    [parentGestureRef],
  );
  const content = (
    <>
      {renderOrganizationHeader?.()}
      {listHeaderComponent}
      {renderSections(headerSections)}
      {renderSections(groupedSections, showGroupedHeaders)}
      {organizationFooter}
      {listFooterComponent}
    </>
  );
  if (platformIsNative) {
    return (
      <View style={styles.container}>
        <NestableScrollContainer
          {...nativeScrollGestureProps}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-organization-list-scroll"
        >
          {content}
        </NestableScrollContainer>
      </View>
    );
  }
  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        testID="sidebar-organization-list-scroll"
      >
        {content}
      </ScrollView>
    </View>
  );
}

function ProjectListSectionHeader({
  label,
  count,
  kind,
  collectionId,
  onRename,
  onDelete,
}: {
  label: string;
  count: number;
  kind: "group" | "pinned" | "default";
  collectionId?: string;
  onRename?: (collectionId: string, name: string) => void;
  onDelete?: (collectionId: string, name: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleRename = useCallback(() => {
    if (collectionId) onRename?.(collectionId, label);
  }, [collectionId, label, onRename]);
  const handleDelete = useCallback(() => {
    if (collectionId) onDelete?.(collectionId, label);
  }, [collectionId, label, onDelete]);
  const leading =
    kind === "pinned" ? (
      <ThemedPin size={14} uniProps={foregroundMutedColorMapping} />
    ) : (
      <ThemedFolder size={14} uniProps={foregroundMutedColorMapping} />
    );
  return (
    <View style={styles.projectSectionHeader}>
      <View style={styles.projectSectionIdentity}>
        {leading}
        <Text numberOfLines={1} style={styles.projectSectionLabel}>
          {label}
        </Text>
        <Text style={styles.projectSectionCount}>· {count}</Text>
      </View>
      {kind === "group" && collectionId && (onRename || onDelete) ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            accessibilityLabel={t("sidebar.organization.projectGroup.actionsAccessibility", {
              name: label,
            })}
            accessibilityRole={platformIsWeb ? undefined : "button"}
            hitSlop={8}
            style={projectSectionKebabStyle}
          >
            <ThemedMoreVertical size={14} uniProps={foregroundMutedColorMapping} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={220}>
            {onRename ? (
              <DropdownMenuItem leading={pencilLeadingIcon} onSelect={handleRename}>
                {t("sidebar.organization.projectGroup.renameTitle")}
              </DropdownMenuItem>
            ) : null}
            {onDelete ? (
              <DropdownMenuItem destructive leading={trash2LeadingIcon} onSelect={handleDelete}>
                {t("sidebar.organization.projectGroup.delete")}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </View>
  );
}

function ProjectModeList({
  pinnedProjects,
  groupProjectsByCollection,
  projectHeadersOnly,
  suppressEmptyState,
  middleContent,
  projects,
  workspaceEntriesByKey,
  collapsedProjectKeys,
  onToggleProjectCollapsed,
  shortcutIndexByWorkspaceKey,
  onWorkspacePress,
  onAddProject,
  listFooterComponent,
  listHeaderComponent,
  parentGestureRef,
  pathname,
  hostLabelByServerId,
  showHostLabels,
  supportsMultiplicityByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  renderOrganizationHeader,
  organizationFooter,
}: Omit<
  SidebarWorkspaceListProps,
  "statusGroups" | "pinnedGroups" | "projectNamesByKey" | "groupMode" | "isRefreshing" | "onRefresh"
> & {
  pinnedProjects: SidebarProjectEntry[];
  groupProjectsByCollection: boolean;
  projectHeadersOnly: boolean;
  suppressEmptyState: boolean;
  middleContent: ReactElement | null;
  pathname: string;
  hostLabelByServerId: ReadonlyMap<string, string>;
  showHostLabels: boolean;
  supportsMultiplicityByServerId: ReadonlyMap<string, boolean>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  renderOrganizationHeader: () => ReactElement | null;
  organizationFooter: ReactElement | null;
}) {
  const { t } = useTranslation();
  const [creatingWorkspaceIds, setCreatingWorkspaceIds] = useState<Set<string>>(() => new Set());
  const creatingWorkspaceTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const showShortcutBadges = useShowShortcutBadges();
  const sortMode = useSidebarViewStore((state) => state.sortMode);
  const workspaceDragEnabled = sortMode === "custom";
  const [renamingProjectGroup, setRenamingProjectGroup] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const projectCollections = useSidebarProjectPreferencesStore((state) => state.collections);
  const collectionIdByProjectKey = useSidebarProjectPreferencesStore(
    (state) => state.collectionIdByProjectKey,
  );
  const renameProjectGroup = useSidebarProjectPreferencesStore((state) => state.renameCollection);
  const deleteProjectGroup = useSidebarProjectPreferencesStore((state) => state.deleteCollection);
  const allProjects = useMemo(() => [...pinnedProjects, ...projects], [pinnedProjects, projects]);
  const projectDragEnabled = workspaceDragEnabled && !groupProjectsByCollection;
  const projectCollectionGroups = useMemo(() => {
    const groups = [...projectCollections]
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
      )
      .map((collection) => ({
        key: collection.id,
        collectionId: collection.id as string | null,
        label: collection.name,
        projects: [] as SidebarProjectEntry[],
      }));
    const groupById = new Map(groups.map((group) => [group.key, group]));
    const unassigned: SidebarProjectEntry[] = [];
    for (const project of projects) {
      const collectionId = collectionIdByProjectKey[project.projectKey];
      const group = collectionId ? groupById.get(collectionId) : null;
      if (group) group.projects.push(project);
      else unassigned.push(project);
    }
    if (unassigned.length > 0) {
      groups.push({
        key: "no-project-collection",
        collectionId: null,
        label: t("sidebar.organization.project.noProjectGroup"),
        projects: unassigned,
      });
    }
    return groups;
  }, [collectionIdByProjectKey, projectCollections, projects, t]);
  const handleRenameProjectGroup = useCallback(
    (name: string) => {
      if (!renamingProjectGroup) return;
      renameProjectGroup(renamingProjectGroup.id, name);
      setRenamingProjectGroup(null);
    },
    [renameProjectGroup, renamingProjectGroup],
  );
  const handleOpenRenameProjectGroup = useCallback((id: string, name: string) => {
    setRenamingProjectGroup({ id, name });
  }, []);
  const handleCloseRenameProjectGroup = useCallback(() => {
    setRenamingProjectGroup(null);
  }, []);
  const handleDeleteProjectGroup = useCallback(
    (collectionId: string, name: string) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("sidebar.organization.projectGroup.delete"),
          message: t("sidebar.organization.projectGroup.deleteMessage", { name }),
          confirmLabel: t("sidebar.organization.projectGroup.delete"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (confirmed) deleteProjectGroup(collectionId);
      })();
    },
    [deleteProjectGroup, t],
  );

  const getProjectOrder = useSidebarOrderStore((state) => state.getProjectOrder);
  const setProjectOrder = useSidebarOrderStore((state) => state.setProjectOrder);
  const getWorkspaceOrder = useSidebarOrderStore((state) => state.getWorkspaceOrder);
  const setWorkspaceOrder = useSidebarOrderStore((state) => state.setWorkspaceOrder);

  const isWorkspaceRoute = useMemo(
    () => Boolean(pathname && parseHostWorkspaceRouteFromPathname(pathname)),
    [pathname],
  );
  const selectionEnabled = isWorkspaceRoute;
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const projectIconTargets = useMemo(
    () =>
      allProjects.flatMap((project) => {
        const target = resolveSidebarProjectIconTarget(project);
        return target ? [{ projectKey: project.projectKey, ...target }] : [];
      }),
    [allProjects],
  );
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
    projects: projectIconTargets,
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
    for (const project of allProjects) {
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
  }, [allProjects, creatingWorkspaceIds]);

  const handleProjectDragEnd = useCallback(
    (reorderedProjects: SidebarProjectEntry[]) => {
      const reorderedProjectKeys = reorderedProjects.map((project) => project.projectKey);
      const currentProjectOrder = getProjectOrder();
      if (
        !hasVisibleOrderChanged({
          currentOrder: currentProjectOrder,
          reorderedVisibleKeys: reorderedProjectKeys,
        })
      ) {
        return;
      }

      setProjectOrder(
        mergeWithRemainder({
          currentOrder: currentProjectOrder,
          reorderedVisibleKeys: reorderedProjectKeys,
        }),
      );
    },
    [getProjectOrder, setProjectOrder],
  );

  const handleWorkspaceReorder = useCallback(
    (projectKey: string, reorderedWorkspaces: SidebarWorkspacePlacement[]) => {
      const reorderedWorkspaceKeys = reorderedWorkspaces.map((workspace) => workspace.workspaceKey);
      const currentWorkspaceOrder = getWorkspaceOrder(projectKey);
      if (
        !hasVisibleOrderChanged({
          currentOrder: currentWorkspaceOrder,
          reorderedVisibleKeys: reorderedWorkspaceKeys,
        })
      ) {
        return;
      }

      setWorkspaceOrder(
        projectKey,
        mergeWithRemainder({
          currentOrder: currentWorkspaceOrder,
          reorderedVisibleKeys: reorderedWorkspaceKeys,
        }),
      );
    },
    [getWorkspaceOrder, setWorkspaceOrder],
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
    (
      { item, drag, isActive, dragHandleProps }: DraggableRenderItemInfo<SidebarProjectEntry>,
      enableProjectDrag = true,
    ) => {
      return (
        <MemoProjectBlock
          project={item}
          workspaceEntriesByKey={workspaceEntriesByKey}
          collapsed={collapsedProjectKeys.has(item.projectKey)}
          displayName={item.projectName}
          iconDataUri={projectIconByProjectKey.get(item.projectKey) ?? null}
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
          hostLabelByServerId={hostLabelByServerId}
          showHostLabels={showHostLabels}
          supportsMultiplicityByServerId={supportsMultiplicityByServerId}
          supportsPinningByServerId={supportsPinningByServerId}
          onToggleWorkspacePin={onToggleWorkspacePin}
          projectDragEnabled={enableProjectDrag}
          workspaceDragEnabled={workspaceDragEnabled}
          hideWorkspaceRows={projectHeadersOnly}
        />
      );
    },
    [
      collapsedProjectKeys,
      activeWorkspaceSelection,
      handleWorktreeCreated,
      handleWorkspaceReorder,
      hostLabelByServerId,
      showHostLabels,
      supportsMultiplicityByServerId,
      supportsPinningByServerId,
      onToggleWorkspacePin,
      onWorkspacePress,
      onToggleProjectCollapsed,
      parentGestureRef,
      projectIconByProjectKey,
      projectHeadersOnly,
      selectionEnabled,
      shortcutIndexByWorkspaceKey,
      showShortcutBadges,
      workspaceEntriesByKey,
      creatingWorkspaceIds,
      workspaceDragEnabled,
    ],
  );

  let projectListContent: ReactElement;
  if (allProjects.length === 0 && !suppressEmptyState) {
    projectListContent = (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyTitle} testID="sidebar-project-empty-state">
          {t("sidebar.project.empty.title")}
        </Text>
        <Text style={styles.emptyText}>{t("sidebar.project.empty.description")}</Text>
        <Button variant="ghost" size="sm" leftIcon={Plus} onPress={onAddProject}>
          {t("sidebar.actions.addProject")}
        </Button>
      </View>
    );
  } else if (groupProjectsByCollection) {
    projectListContent = (
      <View style={styles.projectListContainer} testID="sidebar-project-collection-list">
        {pinnedProjects.length > 0 ? (
          <View style={styles.projectGroupSection} testID="sidebar-project-collection-pinned">
            <ProjectListSectionHeader
              label={t("sidebar.organization.sections.pinnedProjects")}
              count={pinnedProjects.length}
              kind="pinned"
            />
            {pinnedProjects.map((project, index) => (
              <View key={project.projectKey}>
                {renderProject({ item: project, index, drag: noop, isActive: false }, false)}
              </View>
            ))}
          </View>
        ) : null}
        {projectCollectionGroups.map((group) => (
          <View
            key={group.key}
            style={styles.projectGroupSection}
            testID={`sidebar-project-collection-${group.key}`}
          >
            <ProjectListSectionHeader
              label={group.label}
              count={group.projects.length}
              kind="group"
              collectionId={group.collectionId ?? undefined}
              onRename={handleOpenRenameProjectGroup}
              onDelete={handleDeleteProjectGroup}
            />
            {group.projects.map((project, index) => (
              <View key={project.projectKey}>
                {renderProject({ item: project, index, drag: noop, isActive: false }, false)}
              </View>
            ))}
          </View>
        ))}
      </View>
    );
  } else if (projectDragEnabled) {
    projectListContent = (
      <View style={styles.projectListContainer} testID="sidebar-project-list">
        {pinnedProjects.length > 0 ? (
          <>
            <ProjectListSectionHeader
              label={t("sidebar.organization.sections.pinnedProjects")}
              count={pinnedProjects.length}
              kind="pinned"
            />
            {pinnedProjects.map((project, index) => (
              <View key={project.projectKey}>
                {renderProject({ item: project, index, drag: noop, isActive: false }, false)}
              </View>
            ))}
          </>
        ) : null}
        {projects.length > 0 ? (
          <>
            {pinnedProjects.length > 0 ? (
              <ProjectListSectionHeader
                label={t("sidebar.organization.sections.projects")}
                count={projects.length}
                kind="default"
              />
            ) : null}
            <View testID="sidebar-unpinned-project-list">
              <DraggableList
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
            </View>
          </>
        ) : null}
      </View>
    );
  } else {
    projectListContent = (
      <View style={styles.projectListContainer} testID="sidebar-project-list">
        {pinnedProjects.length > 0 ? (
          <ProjectListSectionHeader
            label={t("sidebar.organization.sections.pinnedProjects")}
            count={pinnedProjects.length}
            kind="pinned"
          />
        ) : null}
        {pinnedProjects.map((project, index) => (
          <View key={project.projectKey}>
            {renderProject({ item: project, index, drag: noop, isActive: false }, false)}
          </View>
        ))}
        {pinnedProjects.length > 0 && projects.length > 0 ? (
          <ProjectListSectionHeader
            label={t("sidebar.organization.sections.projects")}
            count={projects.length}
            kind="default"
          />
        ) : null}
        {projects.map((project, index) => (
          <View key={project.projectKey}>
            {renderProject({ item: project, index, drag: noop, isActive: false }, false)}
          </View>
        ))}
      </View>
    );
  }

  const content = (
    <>
      {renderOrganizationHeader()}
      {listHeaderComponent}
      {projectListContent}
      {middleContent}
      {organizationFooter}
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
      <AdaptiveRenameModal
        visible={renamingProjectGroup !== null}
        title={t("sidebar.organization.projectGroup.renameTitle")}
        initialValue={renamingProjectGroup?.name ?? ""}
        placeholder={t("sidebar.organization.projectGroup.placeholder")}
        submitLabel={t("renameModal.rename")}
        onClose={handleCloseRenameProjectGroup}
        onSubmit={handleRenameProjectGroup}
        testID="sidebar-rename-project-collection"
      />
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
  pinnedSection: {
    marginBottom: theme.spacing[1],
  },
  projectGroupSection: {
    marginBottom: theme.spacing[2],
  },
  projectSectionHeader: {
    minHeight: 30,
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[1],
  },
  projectSectionIdentity: {
    minWidth: 0,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  projectSectionLabel: {
    minWidth: 0,
    flexShrink: 1,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  projectSectionCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  hiddenProjectsSection: {
    marginBottom: theme.spacing[2],
  },
  hiddenProjectsHeader: {
    minHeight: 32,
    paddingLeft: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[1],
  },
  hiddenProjectsIdentity: {
    minWidth: 0,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  hiddenProjectsLabel: {
    minWidth: 0,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  hiddenProjectRow: {
    minHeight: 36,
    marginLeft: theme.spacing[4],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  hiddenProjectName: {
    minWidth: 0,
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  projectBlock: {
    marginBottom: theme.spacing[1],
  },
  workspaceListContainer: {
    marginLeft: theme.spacing[4],
    paddingLeft: theme.spacing[1],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
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
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  projectWorkspaceCount: {
    minWidth: theme.spacing[4],
    textAlign: "right",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  projectKebabButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  nativeHeaderAction: {
    minHeight: 44,
    minWidth: 44,
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
