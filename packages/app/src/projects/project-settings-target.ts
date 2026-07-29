interface ProjectSettingsTarget {
  projectKey: string;
  hosts: ReadonlyArray<{ serverId: string; projectId?: string }>;
}

export function resolveHostProjectSettingsRouteKey(host: {
  serverId: string;
  projectId?: string;
}): string | null {
  const projectId = host.projectId?.trim();
  if (!projectId) return null;
  return `host:${host.serverId}:project:${projectId}`;
}

export function resolveProjectSettingsRouteKey(project: ProjectSettingsTarget): string {
  for (const host of project.hosts) {
    const hostLocalKey = resolveHostProjectSettingsRouteKey(host);
    if (hostLocalKey) return hostLocalKey;
  }
  return project.projectKey;
}

export function findProjectSettingsTarget<T extends ProjectSettingsTarget>(
  projects: readonly T[],
  routeKey: string,
): T | undefined {
  return findProjectSettingsRouteTarget(projects, routeKey)?.project;
}

export function findProjectSettingsRouteTarget<T extends ProjectSettingsTarget>(
  projects: readonly T[],
  routeKey: string,
): { project: T; serverId: string | null } | undefined {
  const exactProject = projects.find((project) => project.projectKey === routeKey);
  if (exactProject) return { project: exactProject, serverId: null };

  for (const project of projects) {
    const host = project.hosts.find(
      (candidate) => resolveHostProjectSettingsRouteKey(candidate) === routeKey,
    );
    if (host) return { project, serverId: host.serverId };
  }
  return undefined;
}
