import { useMemo } from "react";
import { useWorkspaceStructure } from "@/stores/session-store-hooks";
import { buildHostProjectList, type HostProjectListItem } from "@/projects/host-project-model";

export {
  buildHostProjectList,
  canCreateWorktreeForProjectKind,
  hostProjectFromRoute,
  hostProjectFromWorkspace,
  resolveInitialWorktreeProject,
  resolveSelectedHostProject,
  type HostProjectListItem,
  type HostProjectRouteContext,
} from "@/projects/host-project-model";

export function useHostProjects(serverId: string | null): HostProjectListItem[] {
  const workspaceStructure = useWorkspaceStructure(serverId);
  return useMemo(() => {
    if (!serverId || workspaceStructure.projects.length === 0) {
      return [];
    }
    return buildHostProjectList({ serverId, projects: workspaceStructure.projects });
  }, [serverId, workspaceStructure.projects]);
}
