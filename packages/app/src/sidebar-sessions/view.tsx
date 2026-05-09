import React, { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  Text,
  View,
  type ListRenderItem,
  type PressableStateCallbackType,
} from "react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import { useShallow } from "zustand/shallow";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { isNative as platformIsNative } from "@/constants/platform";
import { SidebarAgentListSkeleton } from "@/components/sidebar-agent-list-skeleton";
import { sidebarProjectChildIndentStyles } from "@/components/sidebar/sidebar-collapsible-project-section";
import {
  SidebarProjectsDraggableList,
  type SidebarProjectDragInfo,
} from "@/components/sidebar/sidebar-projects-draggable-list";
import {
  type AggregatedAgentIdEntry,
  useAggregatedAgentIds,
  useAggregatedAgentsInitialLoad,
} from "@/hooks/use-aggregated-agents";
import {
  WorkspaceTabIcon,
  WorkspaceTabPresentationResolver,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSessionStore } from "@/stores/session-store";
import { navigateToPreparedWorkspaceTab, prepareWorkspaceTab } from "@/utils/workspace-navigation";
import { formatTimeAgo } from "@/utils/time";
import {
  createSidebarSessionWorkspaceLookup,
  resolveSidebarSessionWorkspaceId,
  resolveSidebarSessionWorkspace,
  shouldIncludeSidebarSessionAgent,
  type SidebarSessionGroup,
} from "./session-filtering";
import { selectSidebarSessionSlice } from "./select-sidebar-session-slice";
import type { ResolvedSidebarSessionProject, SidebarSessionFilter } from "./types";
import { useSidebarSessionWorkspaces } from "./use-sidebar-session-workspaces";
import {
  GROUPED_SESSION_LIMIT,
  SidebarSessionGroupFooter,
  SidebarSessionGroupHeader,
  useGroupedSidebarSessionGroups,
  useOrderedAgentProjectShape,
} from "./grouped-view";
import { SidebarSessionRowKebabMenu } from "./session-row-actions";

interface SidebarSessionsViewProps {
  serverId: string | null;
  projects: readonly SidebarProjectEntry[];
  filter: SidebarSessionFilter;
  groupByProject: boolean;
  previewExpandedProjects: ReadonlySet<string>;
  collapsedProjectKeys: ReadonlySet<string>;
  onProjectPreviewExpandedToggle: (projectKey: string) => void;
  onProjectCollapsedToggle: (projectKey: string) => void;
}

export function SidebarSessionsView({
  serverId,
  projects,
  filter,
  groupByProject,
  previewExpandedProjects,
  collapsedProjectKeys,
  onProjectPreviewExpandedToggle,
  onProjectCollapsedToggle,
}: SidebarSessionsViewProps): ReactElement {
  const isInitialLoad = useAggregatedAgentsInitialLoad();
  const workspaces = useSidebarSessionWorkspaces({ serverId, projects });
  const lookup = useMemo(() => createSidebarSessionWorkspaceLookup(workspaces), [workspaces]);
  const filterAgent = useCallback(
    (agent: AggregatedAgentIdEntry) =>
      shouldIncludeSidebarSessionAgent({
        agent,
        filter,
        lookup,
      }),
    [filter, lookup],
  );
  const sessionIds = useAggregatedAgentIds({
    filter: filterAgent,
    sort: "createdAt-desc-stable",
  });
  const resolveCwdToProject = useCallback(
    (cwd: string) => {
      if (!serverId) {
        return null;
      }
      const workspace = resolveSidebarSessionWorkspace(lookup, {
        id: "",
        serverId,
        cwd,
        archivedAt: null,
      });
      if (!workspace) {
        return null;
      }
      return {
        projectKey: workspace.projectKey,
        projectName: workspace.projectName,
        projectIconKey: workspace.projectIconKey,
      };
    },
    [lookup, serverId],
  );

  if (isInitialLoad) {
    return <SidebarAgentListSkeleton />;
  }

  if (groupByProject) {
    return (
      <GroupedSidebarSessionsList
        serverId={serverId}
        sessionIds={sessionIds}
        projects={projects}
        resolveCwdToProject={resolveCwdToProject}
        previewExpandedProjects={previewExpandedProjects}
        collapsedProjectKeys={collapsedProjectKeys}
        onProjectPreviewExpandedToggle={onProjectPreviewExpandedToggle}
        onProjectCollapsedToggle={onProjectCollapsedToggle}
      />
    );
  }

  return <FlatSidebarSessionsList serverId={serverId} sessionIds={sessionIds} />;
}

const FlatSidebarSessionsList = memo(function FlatSidebarSessionsList({
  serverId,
  sessionIds,
}: {
  serverId: string | null;
  sessionIds: readonly string[];
}): ReactElement {
  const renderItem: ListRenderItem<string> = useCallback(
    ({ item }) => (serverId ? <SidebarSessionRow id={item} serverId={serverId} /> : null),
    [serverId],
  );
  const keyExtractor = useCallback((id: string) => `${serverId ?? ""}:${id}`, [serverId]);

  return (
    <FlatList
      data={sessionIds}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      ListEmptyComponent={EmptySessions}
    />
  );
});

const GroupedSidebarSessionsList = memo(function GroupedSidebarSessionsList({
  serverId,
  sessionIds,
  projects,
  resolveCwdToProject,
  previewExpandedProjects,
  collapsedProjectKeys,
  onProjectPreviewExpandedToggle,
  onProjectCollapsedToggle,
}: {
  serverId: string | null;
  sessionIds: readonly string[];
  projects: readonly SidebarProjectEntry[];
  resolveCwdToProject: (cwd: string) => ResolvedSidebarSessionProject | null;
  previewExpandedProjects: ReadonlySet<string>;
  collapsedProjectKeys: ReadonlySet<string>;
  onProjectPreviewExpandedToggle: (projectKey: string) => void;
  onProjectCollapsedToggle: (projectKey: string) => void;
}): ReactElement {
  const agentsWithProjects = useOrderedAgentProjectShape({
    orderedIds: sessionIds,
    serverId: serverId ?? "",
    resolveCwdToProject,
  });
  const groups = useGroupedSidebarSessionGroups({
    agentsWithProjects,
    projects,
    previewExpandedProjects,
    collapsedProjectKeys,
  });

  const groupsByKey = useMemo(() => {
    const map = new Map<string, SidebarSessionGroup>();
    for (const group of groups) {
      map.set(group.projectKey, group);
    }
    return map;
  }, [groups]);

  const projectsWithSessions = useMemo(
    () => projects.filter((project) => groupsByKey.has(project.projectKey)),
    [groupsByKey, projects],
  );

  const renderProject = useCallback(
    ({ project, drag, isDragging, dragHandleProps }: SidebarProjectDragInfo) => {
      const group = groupsByKey.get(project.projectKey);
      if (!group) {
        return <View />;
      }
      return (
        <SidebarSessionGroupSection
          serverId={serverId}
          project={project}
          group={group}
          drag={drag}
          isDragging={isDragging}
          dragHandleProps={dragHandleProps}
          onProjectCollapsedToggle={onProjectCollapsedToggle}
          onProjectPreviewExpandedToggle={onProjectPreviewExpandedToggle}
        />
      );
    },
    [groupsByKey, onProjectCollapsedToggle, onProjectPreviewExpandedToggle, serverId],
  );

  if (projectsWithSessions.length === 0) {
    return (
      <View style={styles.list}>
        <View style={styles.listContent}>
          <EmptySessions />
        </View>
      </View>
    );
  }

  const draggableList = (
    <SidebarProjectsDraggableList
      testID="sidebar-session-group-list"
      projects={projectsWithSessions}
      serverId={serverId}
      renderProject={renderProject}
      nestable={platformIsNative}
    />
  );

  return platformIsNative ? (
    <NestableScrollContainer
      style={styles.list}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      testID="sidebar-session-group-scroll"
    >
      {draggableList}
    </NestableScrollContainer>
  ) : (
    <ScrollView
      style={styles.list}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      testID="sidebar-session-group-scroll"
    >
      {draggableList}
    </ScrollView>
  );
});

const SidebarSessionGroupSection = memo(function SidebarSessionGroupSection({
  serverId,
  project,
  group,
  drag,
  isDragging,
  dragHandleProps,
  onProjectCollapsedToggle,
  onProjectPreviewExpandedToggle,
}: {
  serverId: string | null;
  project: SidebarProjectEntry;
  group: SidebarSessionGroup;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: SidebarProjectDragInfo["dragHandleProps"];
  onProjectCollapsedToggle: (projectKey: string) => void;
  onProjectPreviewExpandedToggle: (projectKey: string) => void;
}): ReactElement {
  const showFooter = !group.isCollapsed && group.totalCount > GROUPED_SESSION_LIMIT;
  const footer = useMemo(
    () =>
      showFooter ? (
        <SidebarSessionGroupFooter
          projectKey={group.projectKey}
          hiddenCount={group.hiddenCount}
          isExpanded={group.isExpanded}
          onPress={onProjectPreviewExpandedToggle}
        />
      ) : null,
    [
      group.hiddenCount,
      group.isExpanded,
      group.projectKey,
      onProjectPreviewExpandedToggle,
      showFooter,
    ],
  );
  return (
    <View>
      <SidebarSessionGroupHeader
        serverId={serverId}
        projectKey={group.projectKey}
        projectName={group.projectName}
        projectIconKey={group.projectIconKey}
        workspaces={project.workspaces}
        isCollapsed={group.isCollapsed}
        isDragging={isDragging}
        drag={drag}
        dragHandleProps={dragHandleProps}
        onToggleCollapsed={onProjectCollapsedToggle}
        footer={footer}
      >
        {serverId
          ? group.visibleIds.map((id) => (
              <SidebarSessionRow key={id} id={id} serverId={serverId} indented />
            ))
          : null}
      </SidebarSessionGroupHeader>
    </View>
  );
});

const SidebarSessionRow = memo(function SidebarSessionRow({
  id,
  serverId,
  indented = false,
}: {
  id: string;
  serverId: string;
  indented?: boolean;
}): ReactElement | null {
  const { theme } = useUnistyles();
  const [isHovered, setIsHovered] = useState(false);
  const agent = useSessionStore(
    useShallow((state) => selectSidebarSessionSlice(state, serverId, id)),
  );
  const agentCwd = agent?.cwd ?? null;

  const handlePress = useCallback(() => {
    if (!agentCwd) {
      return;
    }

    const workspaceId = resolveSidebarSessionWorkspaceId({
      agent: {
        id,
        serverId,
        cwd: agentCwd,
        archivedAt: null,
      },
      workspaces: useSessionStore.getState().sessions[serverId]?.workspaces?.values(),
    });
    if (!workspaceId) {
      return;
    }

    const target = { kind: "agent" as const, agentId: id };
    prepareWorkspaceTab({
      serverId,
      workspaceId,
      target,
    });
    navigateToPreparedWorkspaceTab({
      serverId,
      workspaceId,
      target,
    });
  }, [agentCwd, id, serverId]);

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.row,
      indented && sidebarProjectChildIndentStyles.childRow,
      isHovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [indented, isHovered],
  );

  const titleStyle = useMemo(() => [styles.title, isHovered && styles.titleHovered], [isHovered]);
  const tabDescriptor = useMemo<WorkspaceTabDescriptor>(
    () => ({
      key: `agent_${id}`,
      tabId: `agent_${id}`,
      kind: "agent",
      target: { kind: "agent", agentId: id },
    }),
    [id],
  );

  if (!agent || agent.archivedAt) {
    return null;
  }

  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={agent.title || "New session"}
        onPress={handlePress}
        style={pressableStyle}
        testID={`sidebar-session-row-${serverId}-${id}`}
      >
        <View style={styles.providerIconWrap}>
          <WorkspaceTabPresentationResolver
            tab={tabDescriptor}
            serverId={serverId}
            workspaceId="sidebar-sessions"
          >
            {(presentation) => (
              <WorkspaceTabIcon
                presentation={presentation}
                active={isHovered}
                size={theme.iconSize.sm}
                statusDotBorderColor={isHovered ? theme.colors.surfaceSidebarHover : undefined}
              />
            )}
          </WorkspaceTabPresentationResolver>
        </View>
        <Text style={titleStyle} numberOfLines={1}>
          {agent.title || "New session"}
        </Text>
        <Text style={styles.timeAgo} numberOfLines={1}>
          {formatTimeAgo(agent.lastActivityAt)}
        </Text>
        <SidebarSessionRowKebabMenu serverId={serverId} agentId={id} isHovered={isHovered} />
      </Pressable>
    </View>
  );
});

function EmptySessions(): ReactElement {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyText}>No sessions</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
    minHeight: 0,
  },
  listContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  row: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  providerIconWrap: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: "400",
    lineHeight: 20,
    color: theme.colors.foreground,
    opacity: 0.76,
  },
  titleHovered: {
    opacity: 1,
  },
  timeAgo: {
    flexShrink: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  emptyState: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[6],
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
