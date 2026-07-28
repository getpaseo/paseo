export interface ProjectHostPlacementLike {
  serverId: string;
  iconWorkingDir: string;
}

export interface SidebarProjectEntryLike {
  iconWorkingDir: string;
  hosts: ProjectHostPlacementLike[];
}

export interface ProjectFileManagerPlacement {
  projectPath: string;
  projectServerId?: string | null;
}

export function resolveProjectFileManagerPlacement(
  project: SidebarProjectEntryLike,
  localServerId: string | null,
): ProjectFileManagerPlacement {
  const localPlacement = localServerId
    ? project.hosts.find((host) => host.serverId === localServerId)
    : undefined;

  return {
    projectPath: localPlacement ? localPlacement.iconWorkingDir : project.iconWorkingDir,
    projectServerId: localPlacement ? localPlacement.serverId : project.hosts[0]?.serverId,
  };
}
