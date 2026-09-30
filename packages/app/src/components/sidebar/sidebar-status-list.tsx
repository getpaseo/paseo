import {
  memo,
  useCallback,
  useMemo,
  useState,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from "react";
import { selectionTint } from "@/styles/with-alpha";
import { useTranslation } from "react-i18next";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import type { GestureType } from "react-native-gesture-handler";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { type SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { STATUS_BUCKET_LABEL_KEYS, type StatusBucket } from "@/hooks/sidebar-status-view-model";
import { useScrollSelectedRowIntoView } from "@/components/sidebar/use-scroll-selected-row-into-view";
import type { SidebarWorkspaceGroup } from "@/components/sidebar/sidebar-labels";
import { SidebarFilterEmptyState } from "@/components/sidebar/empty-states";
import type { HostBadgeModel } from "@/hosts/appearance";
import { isWeb as platformIsWeb, isNative as platformIsNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAppSettings } from "@/hooks/use-settings";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { SidebarSurfaceBackdrop } from "@/styles/surface-backdrop";
import { withUnistyles } from "react-native-unistyles";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
} from "@/components/icons/ui-icons";
import { useToast } from "@/contexts/toast-context";
import { WorkspaceRenameModal } from "@/components/workspace-rename-modal";
import { useWorkspaceClipboardActions } from "@/hooks/use-workspace-clipboard-actions";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";
import { toWorktreeArchiveRisk } from "@/git/worktree-archive-warning";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useWorkspaceReadState } from "@/hooks/use-workspace-read-state";
import {
  SidebarWorkspaceRowFrame,
  SidebarWorkspaceRowContent,
  resolveTrailingActionVisibility,
  type SidebarWorkspaceTrailingPresentation,
  SidebarWorkspaceTrailingActionBase,
  SidebarWorkspaceTrailingActionOverlay,
  SidebarWorkspaceTrailingActionSlot,
  sidebarWorkspaceRowStyles,
} from "@/components/sidebar/sidebar-workspace-row-content";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import { getSidebarRowBackdrop } from "@/components/sidebar/sidebar-row-backdrop";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { selectWorkspaceServiceSummary } from "@/components/sidebar/workspace-meta-row";
import {
  SidebarWorkspaceTrailingContent,
  useSidebarWorkspaceTrailing,
  type SidebarWorkspaceTrailing,
} from "@/components/sidebar/workspace-trailing";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import {
  SidebarWorkspaceContextMenu,
  SidebarWorkspaceMenu,
} from "@/components/sidebar/sidebar-workspace-menu";
import { PinnedSectionHeader } from "@/components/sidebar/pinned-section-header";
import { SidebarGroupToggleRow } from "@/components/sidebar/sidebar-group-toggle-row";
import { MONO_FONT_DATASET } from "@/styles/font-dataset";
import { useLimitedSidebarGroup } from "@/components/sidebar/use-limited-sidebar-group";
import type { ToggleSidebarWorkspacePin } from "@/hooks/use-sidebar-workspace-pin";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";
import { useWorkspaceTopicMenu } from "@/topics/use-workspace-topic-menu";

// Themed icon wrappers
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
// One mapping per bucket, resolved through the status-dot producer so a group header and
// the rows under it cannot disagree about what "failed" looks like.
const needsInputColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
});
const failedColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
});
const attentionColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
});
const runningColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
});

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleX = withUnistyles(CircleX);
const EMPTY_SHORTCUT_INDEX = new Map<string, number>();

function statusWorkspaceKeyExtractor(workspace: SidebarWorkspaceEntry): string {
  return workspace.workspaceKey;
}

interface StatusWorkspaceListProps {
  groups: SidebarWorkspaceGroup[];
  pinnedWorkspaces: SidebarWorkspaceEntry[];
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  onPinnedWorkspaceReorder: (workspaces: SidebarWorkspaceEntry[]) => void;
  listHeaderComponent?: ReactNode;
  /** Swaps the group list for the label filter's empty state. Never the header above it. */
  sidebarFilterEmpty?: boolean;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  dragGestureHostActive?: boolean;
}

export function SidebarStatusWorkspaceList({
  groups,
  pinnedWorkspaces,
  projectIconByProjectViewKey,
  shortcutIndexByWorkspaceKey,
  showShortcutBadges,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  onPinnedWorkspaceReorder,
  listHeaderComponent,
  sidebarFilterEmpty = false,
  parentGestureRef,
  dragGestureHostActive,
}: StatusWorkspaceListProps) {
  const collapsedWorkspaceGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedWorkspaceGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const togglePinnedCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.togglePinnedCollapsed,
  );
  const {
    visibleItems: visiblePinnedWorkspaces,
    expanded: pinnedWorkspacesExpanded,
    canToggle: canTogglePinnedWorkspaces,
    toggleExpanded: togglePinnedWorkspacesExpanded,
  } = useLimitedSidebarGroup(pinnedWorkspaces);

  const statusShortcutIndex = showShortcutBadges
    ? shortcutIndexByWorkspaceKey
    : EMPTY_SHORTCUT_INDEX;
  const renderPinnedWorkspace = useCallback(
    ({
      item: workspace,
      drag,
      isActive,
      dragHandleProps,
    }: DraggableRenderItemInfo<SidebarWorkspaceEntry>) => (
      <StatusWorkspaceRow
        workspace={workspace}
        {...buildStatusRowProjectPresentation({
          workspace,
          projectIconByProjectViewKey,
          hostBadgeByServerId,
        })}
        inStatusGroup={false}
        shortcutNumber={statusShortcutIndex.get(workspace.workspaceKey) ?? null}
        showShortcutBadge={showShortcutBadges}
        canPin={supportsPinningByServerId.get(workspace.serverId) === true}
        onToggleWorkspacePin={onToggleWorkspacePin}
        onWorkspacePress={onWorkspacePress}
        drag={drag}
        isDragging={isActive}
        dragHandleProps={dragHandleProps}
      />
    ),
    [
      hostBadgeByServerId,
      onToggleWorkspacePin,
      onWorkspacePress,
      projectIconByProjectViewKey,
      showShortcutBadges,
      statusShortcutIndex,
      supportsPinningByServerId,
    ],
  );
  const content = (
    <>
      {pinnedWorkspaces.length > 0 ? (
        <View style={styles.pinnedSection} testID="sidebar-pinned-section">
          <PinnedSectionHeader collapsed={pinnedCollapsed} onToggle={togglePinnedCollapsed} />
          {pinnedCollapsed ? null : (
            <>
              <DraggableList
                testID="sidebar-pinned-list"
                data={visiblePinnedWorkspaces}
                keyExtractor={statusWorkspaceKeyExtractor}
                renderItem={renderPinnedWorkspace}
                onDragEnd={onPinnedWorkspaceReorder}
                scrollEnabled={false}
                useDragHandle
                nestable={platformIsNative}
                simultaneousGestureRef={parentGestureRef}
                gestureHostPresented={dragGestureHostActive}
              />
              {canTogglePinnedWorkspaces ? (
                <SidebarGroupToggleRow
                  expanded={pinnedWorkspacesExpanded}
                  onPress={togglePinnedWorkspacesExpanded}
                  testID="sidebar-pinned-show-more"
                />
              ) : null}
            </>
          )}
        </View>
      ) : null}
      {listHeaderComponent}
      {sidebarFilterEmpty ? (
        <SidebarFilterEmptyState />
      ) : (
        <StatusGroupList
          groups={groups}
          collapsedWorkspaceGroupKeys={collapsedWorkspaceGroupKeys}
          projectIconByProjectViewKey={projectIconByProjectViewKey}
          shortcutIndex={statusShortcutIndex}
          showShortcutBadges={showShortcutBadges}
          onWorkspacePress={onWorkspacePress}
          hostBadgeByServerId={hostBadgeByServerId}
          supportsPinningByServerId={supportsPinningByServerId}
          onToggleWorkspacePin={onToggleWorkspacePin}
        />
      )}
    </>
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
          {content}
        </NestableScrollContainer>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-status-list-scroll"
        >
          {content}
        </ScrollView>
      )}
    </View>
  );
}

function StatusGroupList({
  groups,
  collapsedWorkspaceGroupKeys,
  projectIconByProjectViewKey,
  shortcutIndex,
  showShortcutBadges,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
}: {
  groups: SidebarWorkspaceGroup[];
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndex: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
}) {
  return (
    <>
      {groups.map((group) => (
        <StatusGroupRows
          key={group.key}
          group={group}
          collapsed={collapsedWorkspaceGroupKeys.has(group.key)}
          projectIconByProjectViewKey={projectIconByProjectViewKey}
          shortcutIndex={shortcutIndex}
          showShortcutBadges={showShortcutBadges}
          onWorkspacePress={onWorkspacePress}
          hostBadgeByServerId={hostBadgeByServerId}
          supportsPinningByServerId={supportsPinningByServerId}
          onToggleWorkspacePin={onToggleWorkspacePin}
        />
      ))}
    </>
  );
}

function StatusGroupRows({
  group,
  collapsed,
  projectIconByProjectViewKey,
  shortcutIndex,
  showShortcutBadges,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
}: {
  group: SidebarWorkspaceGroup;
  collapsed: boolean;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndex: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
}) {
  const {
    visibleItems: visibleWorkspaces,
    expanded: workspacesExpanded,
    canToggle: canToggleWorkspaces,
    toggleExpanded: toggleWorkspacesExpanded,
  } = useLimitedSidebarGroup(group.rows);

  return (
    <View style={collapsed ? undefined : styles.statusGroupBlockExpanded}>
      <StatusGroupHeader group={group} collapsed={collapsed} />
      {!collapsed ? (
        <View
          style={styles.statusWorkspaceListContainer}
          testID={`sidebar-status-group-rows-${group.key}`}
        >
          {visibleWorkspaces.map((workspace) => (
            <StatusWorkspaceRow
              key={workspace.workspaceKey}
              workspace={workspace}
              {...buildStatusRowProjectPresentation({
                workspace,
                projectIconByProjectViewKey,
                hostBadgeByServerId,
              })}
              shortcutNumber={shortcutIndex.get(workspace.workspaceKey) ?? null}
              showShortcutBadge={showShortcutBadges}
              canPin={supportsPinningByServerId.get(workspace.serverId) === true}
              onToggleWorkspacePin={onToggleWorkspacePin}
              onWorkspacePress={onWorkspacePress}
            />
          ))}
          {canToggleWorkspaces ? (
            <SidebarGroupToggleRow
              expanded={workspacesExpanded}
              onPress={toggleWorkspacesExpanded}
              indented
              testID={`sidebar-status-group-show-more-${group.key}`}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

interface StatusRowProjectPresentation {
  hostBadge: HostBadgeModel | null;
  projectName: string;
  projectIconDataUri: string | null;
}

function buildStatusRowProjectPresentation({
  workspace,
  projectIconByProjectViewKey,
  hostBadgeByServerId,
}: {
  workspace: SidebarWorkspaceEntry;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
}): StatusRowProjectPresentation {
  return {
    hostBadge: hostBadgeByServerId.get(workspace.serverId) ?? null,
    projectName: workspace.projectName,
    projectIconDataUri: projectIconByProjectViewKey.get(workspace.projectViewKey) ?? null,
  };
}

function StatusGroupHeader({
  group,
  collapsed,
}: {
  group: SidebarWorkspaceGroup;
  collapsed: boolean;
}) {
  const { t } = useTranslation();
  const label = t(STATUS_BUCKET_LABEL_KEYS[group.leading.bucket]);
  const [isHovered, setIsHovered] = useState(false);
  const toggleWorkspaceGroupCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleWorkspaceGroupCollapsed,
  );
  const handlePress = useCallback(() => {
    toggleWorkspaceGroupCollapsed(group.key);
  }, [group.key, toggleWorkspaceGroupCollapsed]);
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
        accessibilityLabel={`${label} group`}
        accessibilityState={accessibilityState}
        style={rowStyle}
        onPress={handlePress}
        testID={`sidebar-status-group-${group.key}`}
      >
        <View style={styles.statusGroupRowLeft}>
          <View style={styles.statusGroupLeadingVisualSlot}>
            <StatusGroupLeadingVisual
              leading={group.leading}
              collapsed={collapsed}
              showChevron={isHovered}
            />
          </View>
          <View style={styles.statusGroupTitleGroup}>
            <Text style={styles.statusGroupTitle} numberOfLines={1}>
              {label}
            </Text>
            <Text
              dataSet={MONO_FONT_DATASET}
              style={styles.statusGroupCount}
              testID={`sidebar-status-group-count-${group.key}`}
            >
              {group.rows.length}
            </Text>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

function StatusGroupLeadingVisual({
  leading,
  collapsed,
  showChevron,
}: {
  leading: SidebarWorkspaceGroup["leading"];
  collapsed: boolean;
  showChevron: boolean;
}) {
  if (!showChevron) {
    return <StatusGroupIcon bucket={leading.bucket} />;
  }
  if (collapsed) {
    return <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} />;
  }
  return <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />;
}

function StatusGroupIcon({ bucket }: { bucket: StatusBucket }) {
  switch (bucket) {
    case "needs_input":
      return <ThemedCircleAlert size={14} uniProps={needsInputColorMapping} />;
    case "failed":
      return <ThemedCircleX size={14} uniProps={failedColorMapping} />;
    case "attention":
      return <ThemedCircleCheck size={14} uniProps={attentionColorMapping} />;
    case "running":
      return <ThemedCircleDot size={14} uniProps={runningColorMapping} />;
    case "done":
      return <ThemedCircleCheck size={14} uniProps={foregroundMutedColorMapping} />;
  }
}

const StatusWorkspaceRow = memo(function StatusWorkspaceRow({
  workspace,
  hostBadge,
  projectName,
  projectIconDataUri,
  shortcutNumber,
  showShortcutBadge,
  canPin,
  onToggleWorkspacePin,
  reserveIdleStatusIndicatorSpace = true,
  inStatusGroup = true,
  onWorkspacePress,
  drag,
  isDragging = false,
  dragHandleProps,
}: {
  workspace: SidebarWorkspaceEntry;
  hostBadge: HostBadgeModel | null;
  projectName: string;
  projectIconDataUri: string | null;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  reserveIdleStatusIndicatorSpace?: boolean;
  /**
   * Whether the row sits under a status header, which is what it indents from. Pinned rows
   * are a flat list under their own header and sit flush.
   */
  inStatusGroup?: boolean;
  onWorkspacePress?: () => void;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const selected =
    activeWorkspaceSelection?.serverId === workspace.serverId &&
    activeWorkspaceSelection?.workspaceId === workspace.workspaceId;

  const handlePress = useCallback(() => {
    if (!workspace.serverId) return;
    onWorkspacePress?.();
    navigateToWorkspace({ serverId: workspace.serverId, workspaceId: workspace.workspaceId });
  }, [onWorkspacePress, workspace.serverId, workspace.workspaceId]);

  return (
    <StatusWorkspaceRowWithMenu
      workspace={workspace}
      hostBadge={hostBadge}
      projectName={projectName}
      projectIconDataUri={projectIconDataUri}
      selected={selected}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      canPin={canPin}
      onToggleWorkspacePin={onToggleWorkspacePin}
      reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
      inStatusGroup={inStatusGroup}
      onPress={handlePress}
      drag={drag}
      isDragging={isDragging}
      dragHandleProps={dragHandleProps}
    />
  );
});

function StatusWorkspaceRowWithMenu({
  workspace,
  hostBadge,
  projectName,
  projectIconDataUri,
  selected,
  shortcutNumber,
  showShortcutBadge,
  canPin,
  onToggleWorkspacePin,
  reserveIdleStatusIndicatorSpace = true,
  inStatusGroup = true,
  onPress,
  drag,
  isDragging = false,
  dragHandleProps,
}: {
  workspace: SidebarWorkspaceEntry;
  hostBadge: HostBadgeModel | null;
  projectName: string;
  projectIconDataUri: string | null;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  reserveIdleStatusIndicatorSpace?: boolean;
  /**
   * Whether the row sits under a status header, which is what it indents from. Pinned rows
   * are a flat list under their own header and sit flush.
   */
  inStatusGroup?: boolean;
  onPress: () => void;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
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
    if (isArchiving) return;
    archiveController.archive();
  }, [archiveController, isArchiving]);

  const clipboard = useWorkspaceClipboardActions();
  const handleCopyPath = useCallback(() => {
    clipboard.copyPath(workspace);
  }, [clipboard, workspace]);

  const handleCopyBranchName = useCallback(() => {
    clipboard.copyBranchName(workspace);
  }, [clipboard, workspace]);

  const handleOpenRename = useCallback(() => setIsRenameOpen(true), []);
  const handleCloseRename = useCallback(() => setIsRenameOpen(false), []);

  // Row-level like rename: the dialog must survive the hover-gated kebab
  // menu unmounting when its item is selected.
  const isPinned = workspace.pinnedAt != null;
  const handleTogglePin = useCallback(() => {
    onToggleWorkspacePin(workspace);
  }, [onToggleWorkspacePin, workspace]);
  const onTogglePin = canPin ? handleTogglePin : undefined;

  const { onCombineIntoTopic, onDetachFromTopic, topicDialog } = useWorkspaceTopicMenu({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
  });
  const archiveShortcutKeys = useShortcutKeys("archive-workspace");
  const { hasClearableAttention, canMarkUnread, clearAttention, markUnread } =
    useWorkspaceReadState({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
    });
  const handleMarkAsRead = useCallback(() => {
    void clearAttention().catch((error) => {
      toast.error(error instanceof Error ? error.message : "Failed to mark workspace as read");
    });
  }, [clearAttention, toast]);
  const handleMarkAsUnread = useCallback(() => {
    void markUnread().catch((error) => {
      toast.error(error instanceof Error ? error.message : "Failed to mark workspace as unread");
    });
  }, [markUnread, toast]);

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
      <StatusWorkspaceRowInner
        workspace={workspace}
        hostBadge={hostBadge}
        projectName={projectName}
        projectIconDataUri={projectIconDataUri}
        selected={selected}
        shortcutNumber={shortcutNumber}
        showShortcutBadge={showShortcutBadge}
        onPress={onPress}
        isArchiving={isArchiving}
        archiveLabel={t("sidebar.workspace.actions.archive")}
        archiveStatus={isArchiving ? "pending" : "idle"}
        archivePendingLabel={t("sidebar.workspace.actions.archiving")}
        onArchive={handleArchive}
        onCopyBranchName={workspace.projectKind === "git" ? handleCopyBranchName : undefined}
        onCopyPath={handleCopyPath}
        onRename={handleOpenRename}
        onCombineIntoTopic={onCombineIntoTopic}
        onDetachFromTopic={onDetachFromTopic}
        onMarkAsRead={hasClearableAttention ? handleMarkAsRead : undefined}
        onMarkAsUnread={canMarkUnread ? handleMarkAsUnread : undefined}
        archiveShortcutKeys={selected ? archiveShortcutKeys : null}
        isPinned={isPinned}
        onTogglePin={onTogglePin}
        reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
        inStatusGroup={inStatusGroup}
        drag={drag}
        isDragging={isDragging}
        dragHandleProps={dragHandleProps}
      />
      <WorkspaceRenameModal
        visible={isRenameOpen}
        workspace={workspace}
        onClose={handleCloseRename}
        testID={`sidebar-workspace-rename-modal-${workspace.workspaceKey}`}
      />
      {topicDialog}
    </>
  );
}

interface StatusWorkspaceRowInnerProps {
  workspace: SidebarWorkspaceEntry;
  hostBadge: HostBadgeModel | null;
  projectName: string;
  projectIconDataUri: string | null;
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
  onCombineIntoTopic?: () => void;
  onDetachFromTopic?: () => void;
  onMarkAsRead?: () => void;
  onMarkAsUnread?: () => void;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  isPinned?: boolean;
  onTogglePin?: () => void;
  reserveIdleStatusIndicatorSpace?: boolean;
  /** Pinned rows are flat under their own header; status-group rows indent from theirs. */
  inStatusGroup?: boolean;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

function StatusWorkspaceRowInner(props: StatusWorkspaceRowInnerProps) {
  if (props.drag) {
    return <DraggableStatusWorkspaceRowInner {...props} drag={props.drag} />;
  }
  return <StatusWorkspaceRowInnerContent {...props} />;
}

function DraggableStatusWorkspaceRowInner(
  props: StatusWorkspaceRowInnerProps & { drag: () => void },
) {
  const dragInteraction = useLongPressDragInteraction({
    drag: props.drag,
    menuController: null,
  });
  return <StatusWorkspaceRowInnerContent {...props} dragInteraction={dragInteraction} />;
}

function StatusWorkspaceRowInnerContent({
  workspace,
  hostBadge,
  projectName,
  projectIconDataUri,
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
  onCombineIntoTopic,
  onDetachFromTopic,
  onMarkAsRead,
  onMarkAsUnread,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
  reserveIdleStatusIndicatorSpace = true,
  inStatusGroup = true,
  isDragging = false,
  dragHandleProps,
  dragInteraction,
}: StatusWorkspaceRowInnerProps & {
  dragInteraction?: ReturnType<typeof useLongPressDragInteraction>;
}) {
  const isCompact = useIsCompactFormFactor();
  const isTouchPlatform = platformIsNative || isCompact;
  const { settings } = useAppSettings();
  const isCardCompact = isCompact && settings.sessionCardStyle === "card";
  const [isPressed, setIsPressed] = useState(false);
  const trailing = useSidebarWorkspaceTrailing();
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};

  const isDesktop = !isTouchPlatform;
  const serviceSummary = isDesktop ? selectWorkspaceServiceSummary(workspace.scripts) : null;

  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  useScrollSelectedRowIntoView(selected, workspace.workspaceKey);
  const didLongPressRef = dragInteraction?.didLongPressRef;
  const startDragPress = dragInteraction?.handlePressIn;
  const moveDragPress = dragInteraction?.handleTouchMove;
  const endDragPress = dragInteraction?.handlePressOut;
  const handlePress = useCallback(() => {
    if (didLongPressRef?.current) {
      didLongPressRef.current = false;
      return;
    }
    onPress();
  }, [didLongPressRef, onPress]);
  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      setIsPressed(true);
      startDragPress?.(event);
    },
    [startDragPress],
  );
  const handlePressOut = useCallback(() => {
    setIsPressed(false);
    endDragPress?.();
  }, [endDragPress]);

  return (
    <SidebarWorkspaceRowFrame workspace={workspace} isDragging={isDragging}>
      {({ isHovered, contextMenuOpen, onContextMenuOpenChange, hoverHandlers }) => {
        const showShortcut = showShortcutBadge && shortcutNumber !== null;
        const {
          trailingPresentation,
          showKebab: showKebabInSlot,
          showScrim,
          renderSlot,
          reserveSlotWidth,
        } = resolveTrailingActionVisibility({
          workspace,
          trailing,
          hasArchiveAction: Boolean(onArchive),
          isHovered,
          isTouchPlatform,
          showShortcut,
        });
        const workspaceRowStyle = getStatusWorkspaceRowStyle({
          isPressed,
          selected,
          isHovered,
          inStatusGroup,
          isDragging,
          isCardCompact,
        });
        const backdrop = getSidebarRowBackdrop({ isDragging, isPressed, selected, isHovered });
        return (
          <View
            {...dragAttributes}
            {...dragHandleProps?.listeners}
            ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
            style={styles.workspaceRowContainer}
            {...hoverHandlers}
          >
            <SidebarWorkspaceContextMenu
              contextMenuOpen={contextMenuOpen}
              onContextMenuOpenChange={onContextMenuOpenChange}
              workspace={workspace}
              leadingProjectName={projectName}
              hostBadgeLabel={hostBadge?.label}
              serviceSummary={serviceSummary}
              workspaceKey={workspace.workspaceKey}
              onCopyPath={onCopyPath}
              onCopyBranchName={onCopyBranchName}
              onRename={onRename}
              onCombineIntoTopic={onCombineIntoTopic}
              onDetachFromTopic={onDetachFromTopic}
              onMarkAsRead={onMarkAsRead}
              onMarkAsUnread={onMarkAsUnread}
              onArchive={onArchive}
              archiveLabel={archiveLabel}
              archiveStatus={archiveStatus}
              archivePendingLabel={archivePendingLabel}
              archiveShortcutKeys={archiveShortcutKeys}
              isPinned={isPinned}
              onTogglePin={onTogglePin}
              openInFileManagerPath={workspace.workspaceDirectory}
              disabled={isArchiving}
              accessibilityRole="button"
              accessibilityState={accessibilityState}
              style={workspaceRowStyle}
              highlightStyle={styles.workspaceRowPressed}
              onPressIn={handlePressIn}
              onTouchMove={moveDragPress}
              onPressOut={handlePressOut}
              onPress={handlePress}
              testID={`sidebar-workspace-row-${workspace.workspaceKey}`}
            >
              <SidebarWorkspaceRowContent
                workspace={workspace}
                hostBadge={hostBadge}
                leadingProjectName={projectName}
                leadingProjectIconDataUri={projectIconDataUri}
                serviceSummary={serviceSummary}
                backdrop={backdrop}
                isHovered={isHovered}
                isLoading={isArchiving}
                shortcutNumber={shortcutNumber}
                showShortcutBadge={showShortcutBadge}
                reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
              >
                {renderSlot ? (
                  <StatusWorkspaceActionSlot
                    workspace={workspace}
                    backdrop={backdrop}
                    trailing={trailing}
                    trailingPresentation={trailingPresentation}
                    showKebab={showKebabInSlot}
                    showScrim={showScrim}
                    reserveSlotWidth={reserveSlotWidth}
                    isPinned={isPinned}
                    onTogglePin={onTogglePin}
                    onCopyPath={onCopyPath}
                    onCopyBranchName={onCopyBranchName}
                    onRename={onRename}
                    onCombineIntoTopic={onCombineIntoTopic}
                    onDetachFromTopic={onDetachFromTopic}
                    onMarkAsRead={onMarkAsRead}
                    onMarkAsUnread={onMarkAsUnread}
                    onArchive={onArchive}
                    archiveLabel={archiveLabel}
                    archiveStatus={archiveStatus}
                    archivePendingLabel={archivePendingLabel}
                    archiveShortcutKeys={archiveShortcutKeys}
                  />
                ) : null}
              </SidebarWorkspaceRowContent>
            </SidebarWorkspaceContextMenu>
          </View>
        );
      }}
    </SidebarWorkspaceRowFrame>
  );
}

function StatusWorkspaceActionSlot({
  workspace,
  backdrop,
  trailing,
  trailingPresentation,
  showKebab,
  showScrim,
  reserveSlotWidth,
  isPinned,
  onTogglePin,
  onCopyPath,
  onCopyBranchName,
  onRename,
  onCombineIntoTopic,
  onDetachFromTopic,
  onMarkAsRead,
  onMarkAsUnread,
  onArchive,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
}: {
  workspace: SidebarWorkspaceEntry;
  backdrop: SidebarSurfaceBackdrop;
  trailing: SidebarWorkspaceTrailing;
  trailingPresentation: SidebarWorkspaceTrailingPresentation;
  showKebab: boolean;
  showScrim: boolean;
  reserveSlotWidth: boolean;
  isPinned?: boolean;
  onTogglePin?: () => void;
  onCopyPath?: () => void;
  onCopyBranchName?: () => void;
  onRename?: () => void;
  onCombineIntoTopic?: () => void;
  onDetachFromTopic?: () => void;
  onMarkAsRead?: () => void;
  onMarkAsUnread?: () => void;
  onArchive?: () => void;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  archiveShortcutKeys?: ShortcutKey[][] | null;
}) {
  const kebab = useOpenKebabMenuVisibility(showKebab);
  return (
    <SidebarWorkspaceTrailingActionSlot reserveWidth={reserveSlotWidth}>
      <SidebarWorkspaceTrailingActionBase presentation={trailingPresentation}>
        <SidebarWorkspaceTrailingContent workspace={workspace} trailing={trailing} />
      </SidebarWorkspaceTrailingActionBase>
      <SidebarWorkspaceTrailingActionOverlay
        visible={kebab.showKebab}
        scrimBackdrop={showScrim ? backdrop : undefined}
      >
        {kebab.showKebab && onArchive ? (
          <SidebarWorkspaceMenu
            {...kebab.menuProps}
            workspaceKey={workspace.workspaceKey}
            serverId={workspace.serverId}
            workspaceId={workspace.workspaceId}
            workspaceLabels={workspace.labels}
            onCopyPath={onCopyPath}
            onCopyBranchName={onCopyBranchName}
            onRename={onRename}
            onCombineIntoTopic={onCombineIntoTopic}
            onDetachFromTopic={onDetachFromTopic}
            onMarkAsRead={onMarkAsRead}
            onMarkAsUnread={onMarkAsUnread}
            onArchive={onArchive}
            archiveLabel={archiveLabel}
            archiveStatus={archiveStatus}
            archivePendingLabel={archivePendingLabel}
            archiveShortcutKeys={archiveShortcutKeys}
            isPinned={isPinned}
            onTogglePin={onTogglePin}
          />
        ) : null}
      </SidebarWorkspaceTrailingActionOverlay>
    </SidebarWorkspaceTrailingActionSlot>
  );
}

function getStatusWorkspaceRowStyle({
  isPressed,
  selected,
  isHovered,
  inStatusGroup,
  isDragging,
  isCardCompact,
}: {
  isPressed: boolean;
  selected: boolean;
  isHovered: boolean;
  inStatusGroup: boolean;
  isDragging: boolean;
  isCardCompact: boolean;
}) {
  return [
    styles.workspaceRow,
    isCardCompact && styles.workspaceRowCard,
    inStatusGroup && sidebarWorkspaceRowStyles.rowIndented,
    isHovered && styles.workspaceRowHovered,
    selected && styles.sidebarRowSelected,
    isDragging && styles.workspaceRowDragging,
    isPressed && styles.workspaceRowPressed,
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
    // Keep status mode's Pinned/Workspaces boundary identical to project mode.
    paddingTop: 2,
    paddingBottom: theme.spacing[4],
  },
  pinnedSection: {
    marginBottom: theme.spacing[1],
  },
  // Matches `projectBlockExpanded` in sidebar-workspace-list.tsx. See the note there.
  statusGroupBlockExpanded: {
    paddingBottom: theme.spacing[3],
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
  // Small tracked capitals: the group names a region of the Leiste, it is not a row to act on.
  statusGroupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    minWidth: 0,
    flexShrink: 1,
  },
  statusGroupCount: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  workspaceRowContainer: {
    position: "relative",
  },
  workspaceRow: {
    minHeight: 36,
    marginBottom: theme.spacing[0.5],
    paddingVertical: {
      xs: theme.spacing[3],
      md: theme.spacing[2],
    },
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "flex-start",
    gap: theme.spacing[1],
    userSelect: "none",
  },
  workspaceRowCard: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[4],
  },
  workspaceRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
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
  // Where you are must read at a glance, distinct from hover: accent fill plus a left bar.
  sidebarRowSelected: {
    backgroundColor: selectionTint({
      accent: theme.colors.accent,
      surface: theme.colors.surfaceSidebar,
      isWeb: platformIsWeb,
    }),
    boxShadow: `inset 3px 0 0 ${theme.colors.accent}`,
  },
}));
