import React, { memo, useCallback, useMemo, useState, type ReactElement, type Ref } from "react";
import { Pressable, Text, View } from "react-native";
import { router, type Href } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { SidebarProjectSection } from "@/components/sidebar/sidebar-collapsible-project-section";
import {
  SidebarProjectTrailingActions,
  type SidebarProjectCreateButtonConfig,
} from "@/components/sidebar/sidebar-project-trailing-actions";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";
import { useProjectIconQuery } from "@/hooks/use-project-icon-query";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSessionStore } from "@/stores/session-store";
import { buildHostNewWorkspaceRoute } from "@/utils/host-routes";
import {
  deriveGroupedSidebarSessions,
  type SidebarSessionAgentProject,
  type SidebarSessionGroup,
} from "./session-filtering";
import type { ResolvedSidebarSessionProject } from "./types";

export const GROUPED_SESSION_LIMIT = 6;

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

type ResolveCwdToProject = (cwd: string) => ResolvedSidebarSessionProject | null;

export function useOrderedAgentProjectShape(input: {
  orderedIds: readonly string[];
  serverId: string;
  resolveCwdToProject: ResolveCwdToProject;
}): readonly SidebarSessionAgentProject[] {
  const { orderedIds, resolveCwdToProject, serverId } = input;
  const selector = useMemo(() => {
    let previousById = new Map<string, SidebarSessionAgentProject>();

    return (state: SessionStoreState) => {
      const agents = state.sessions[serverId]?.agents;
      if (!agents) {
        previousById = new Map();
        return [];
      }

      const nextById = new Map<string, SidebarSessionAgentProject>();
      const agentsWithProjects: SidebarSessionAgentProject[] = [];

      for (const id of orderedIds) {
        const agent = agents.get(id);
        if (!agent) {
          continue;
        }

        const project = resolveCwdToProject(agent.cwd);
        if (!project) {
          continue;
        }

        const previous = previousById.get(id);
        const next =
          previous && previous.projectKey === project.projectKey
            ? previous
            : { id, projectKey: project.projectKey };

        nextById.set(id, next);
        agentsWithProjects.push(next);
      }

      previousById = nextById;
      return agentsWithProjects;
    };
  }, [orderedIds, resolveCwdToProject, serverId]);

  return useStoreWithEqualityFn(useSessionStore, selector, shallow);
}

export function useGroupedSidebarSessionGroups(input: {
  agentsWithProjects: readonly SidebarSessionAgentProject[];
  projects: readonly SidebarProjectEntry[];
  previewExpandedProjects: ReadonlySet<string>;
  collapsedProjectKeys: ReadonlySet<string>;
}): readonly SidebarSessionGroup[] {
  return useMemo(
    () =>
      deriveGroupedSidebarSessions({
        agentsWithProjects: input.agentsWithProjects,
        projects: input.projects,
        previewExpandedProjects: input.previewExpandedProjects,
        collapsedProjectKeys: input.collapsedProjectKeys,
        limit: GROUPED_SESSION_LIMIT,
      }),
    [
      input.agentsWithProjects,
      input.collapsedProjectKeys,
      input.previewExpandedProjects,
      input.projects,
    ],
  );
}

export const SidebarSessionGroupHeader = memo(function SidebarSessionGroupHeader({
  serverId,
  projectKey,
  projectName,
  projectIconKey,
  workspaces,
  isCollapsed,
  isDragging = false,
  drag,
  dragHandleProps,
  onToggleCollapsed,
  children,
  footer = null,
}: {
  serverId: string | null;
  projectKey: string;
  projectName: string;
  projectIconKey: string | null;
  workspaces: readonly SidebarWorkspaceEntry[];
  isCollapsed: boolean;
  isDragging?: boolean;
  drag?: () => void;
  dragHandleProps?: DraggableListDragHandleProps;
  onToggleCollapsed: (projectKey: string) => void;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}): ReactElement {
  const { icon } = useProjectIconQuery({ serverId: serverId ?? "", cwd: projectIconKey ?? "" });
  const dataUri = useMemo(() => {
    if (!icon || !icon.mimeType || !icon.data) {
      return null;
    }
    return `data:${icon.mimeType};base64,${icon.data}`;
  }, [icon]);

  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const sourceDirectory = projectIconKey ?? undefined;
  const handleCreateSessionPress = useCallback(() => {
    if (!serverId || !sourceDirectory) {
      return;
    }
    router.navigate(
      buildHostNewWorkspaceRoute(serverId, sourceDirectory, {
        headerTitle: "New session",
      }) as Href,
    );
  }, [serverId, sourceDirectory]);
  const createButton = useMemo<SidebarProjectCreateButtonConfig | null>(
    () =>
      serverId && sourceDirectory
        ? {
            onPress: handleCreateSessionPress,
            accessibilityLabel: "New session",
            testID: `sidebar-project-${projectKey}-new-session-button`,
            tooltipLabel: "New session",
            icon: "plus" as const,
          }
        : null,
    [handleCreateSessionPress, projectKey, serverId, sourceDirectory],
  );
  const interaction = useLongPressDragInteraction({
    drag: drag ?? noopDrag,
    menuController: null,
  });
  const trailingSlot = useMemo(
    () => (
      <SidebarProjectTrailingActions
        projectKey={projectKey}
        projectName={projectName}
        serverId={serverId}
        isHovered={isHovered}
        workspaces={workspaces}
        createButton={createButton}
      />
    ),
    [createButton, isHovered, projectKey, projectName, serverId, workspaces],
  );
  const handlePress = useCallback(() => {
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    onToggleCollapsed(projectKey);
  }, [interaction.didLongPressRef, onToggleCollapsed, projectKey]);
  const headerProps = useMemo(
    () => ({
      accessibilityLabel: isCollapsed ? `Expand ${projectName}` : `Collapse ${projectName}`,
      onPressIn: drag ? interaction.handlePressIn : undefined,
      onTouchMove: drag ? interaction.handleTouchMove : undefined,
      onPressOut: drag ? interaction.handlePressOut : undefined,
    }),
    [
      drag,
      interaction.handlePressIn,
      interaction.handlePressOut,
      interaction.handleTouchMove,
      isCollapsed,
      projectName,
    ],
  );

  return (
    <View
      {...dragHandleProps?.attributes}
      {...dragHandleProps?.listeners}
      ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <SidebarProjectSection
        projectKey={projectKey}
        projectName={projectName}
        iconDataUri={dataUri}
        chevron={isCollapsed ? "expand" : "collapse"}
        isHovered={isHovered}
        isDragging={isDragging}
        trailingSlot={trailingSlot}
        onPress={handlePress}
        testID={`sidebar-session-group-header-${projectKey}`}
        isCollapsed={isCollapsed}
        footer={footer}
        headerProps={headerProps}
      >
        {children}
      </SidebarProjectSection>
    </View>
  );
});

function noopDrag() {}

export const SidebarSessionGroupFooter = memo(function SidebarSessionGroupFooter({
  projectKey,
  hiddenCount,
  isExpanded,
  onPress,
}: {
  projectKey: string;
  hiddenCount: number;
  isExpanded: boolean;
  onPress: (projectKey: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => {
    onPress(projectKey);
  }, [onPress, projectKey]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={isExpanded ? "Show less sessions" : `Show ${hiddenCount} more sessions`}
      onPress={handlePress}
      style={footerRowStyle}
      testID={`sidebar-session-group-footer-${projectKey}`}
    >
      <Text style={styles.footerText}>{isExpanded ? "Show less" : `Show ${hiddenCount} more`}</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  footerRow: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[3] + theme.spacing[3],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
  },
  footerText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));

const footerRowStyle = styles.footerRow;
