import { useWorkspaceStructure } from "@/stores/session-store-hooks";
import { type HostProjectListItem } from "@/projects/host-project-model";

export {
  canCreateWorkspaceForHostProject,
  canCreateWorktreeForProjectKind,
  filterWorkspaceProjectsForHost,
  getHostProjectSourceDirectory,
  getHostProjectId,
  hostProjectFromRoute,
  hostProjectFromWorkspace,
  resolveInitialWorkspaceProject,
  resolveInitialWorktreeProject,
  resolveSelectedHostProject,
  type HostProjectListItem,
  type HostProjectRouteContext,
} from "@/projects/host-project-model";

export function useHostProjects(serverIds: string[]): HostProjectListItem[] {
  const workspaceStructure = useWorkspaceStructure(serverIds);
  return workspaceStructure.projects;
}
