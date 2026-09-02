export interface ProjectIconPlacement {
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  customIconRevision?: string | null;
  iconRevision?: string;
}

export interface ProjectIconTarget extends ProjectIconPlacement {
  projectViewKey: string;
}

export function createProjectIconTarget(input: {
  projectViewKey: string;
  placement: ProjectIconPlacement;
}): ProjectIconTarget | null {
  const iconWorkingDir = input.placement.iconWorkingDir.trim();
  if (!input.placement.serverId || !input.placement.projectId || !iconWorkingDir) return null;
  return {
    projectViewKey: input.projectViewKey,
    serverId: input.placement.serverId,
    projectId: input.placement.projectId,
    iconWorkingDir,
    customIconRevision: input.placement.customIconRevision,
    iconRevision: input.placement.iconRevision,
  };
}
