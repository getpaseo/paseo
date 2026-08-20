import type { HostProjectListItem } from "@/projects/host-projects";

export interface NewWorkspaceProjectIconTarget {
  projectViewKey: string;
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  customIconRevision?: string | null;
  iconRevision?: string;
}

export function buildNewWorkspaceProjectIconTargets(
  projects: readonly HostProjectListItem[],
  serverId: string,
): NewWorkspaceProjectIconTarget[] {
  return projects.flatMap((project) => {
    const host = project.hosts.find((candidate) => candidate.serverId === serverId);
    const iconWorkingDir = host?.iconWorkingDir.trim();
    if (!host || !iconWorkingDir) return [];
    return [
      {
        projectViewKey: project.viewKey,
        projectId: host.projectId,
        serverId,
        iconWorkingDir,
        customIconRevision: host.customIconRevision,
        iconRevision: host.iconRevision,
      },
    ];
  });
}
