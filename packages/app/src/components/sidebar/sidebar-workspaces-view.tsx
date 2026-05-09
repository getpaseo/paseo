import type { ReactElement, MutableRefObject } from "react";
import type { GestureType } from "react-native-gesture-handler";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { SidebarAgentListSkeleton } from "../sidebar-agent-list-skeleton";
import { SidebarWorkspaceList } from "../sidebar-workspace-list";

interface SidebarWorkspacesViewProps {
  serverId: string | null;
  projects: SidebarProjectEntry[];
  isInitialLoad: boolean;
  isRefreshing: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  onToggleProjectCollapsed: (projectKey: string) => void;
  onRefresh: () => void;
  onAddProject: () => void;
  onWorkspacePress?: () => void;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
}

export function SidebarWorkspacesView({
  serverId,
  projects,
  isInitialLoad,
  isRefreshing,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  onToggleProjectCollapsed,
  onRefresh,
  onAddProject,
  onWorkspacePress,
  parentGestureRef,
}: SidebarWorkspacesViewProps): ReactElement {
  if (isInitialLoad) {
    return <SidebarAgentListSkeleton />;
  }

  return (
    <SidebarWorkspaceList
      serverId={serverId}
      collapsedProjectKeys={collapsedProjectKeys}
      onToggleProjectCollapsed={onToggleProjectCollapsed}
      shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
      projects={projects}
      isRefreshing={isRefreshing}
      onRefresh={onRefresh}
      onWorkspacePress={onWorkspacePress}
      onAddProject={onAddProject}
      parentGestureRef={parentGestureRef}
    />
  );
}
