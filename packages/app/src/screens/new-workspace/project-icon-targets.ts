import type { HostProjectListItem } from "@/projects/host-projects";
import { createProjectIconTarget, type ProjectIconTarget } from "@/projects/icon-target";

export function buildNewWorkspaceProjectIconTargets(
  projects: readonly HostProjectListItem[],
  serverId: string,
): ProjectIconTarget[] {
  return projects.flatMap((project) => {
    const host = project.hosts.find((candidate) => candidate.serverId === serverId);
    if (!host) return [];
    const target = createProjectIconTarget({ projectViewKey: project.viewKey, placement: host });
    return target ? [target] : [];
  });
}
