import { resolveProjectGroupKey } from "./project-group-key";

interface ProjectSettingsTarget {
  projectKey: string;
  hosts: ReadonlyArray<{ serverId: string; projectId?: string }>;
}

function resolveHostLocalProjectKey(host: { serverId: string; projectId?: string }): string | null {
  const projectId = host.projectId?.trim();
  if (!projectId) return null;
  return resolveProjectGroupKey({ serverId: host.serverId, projectId });
}

export function resolveProjectSettingsRouteKey(project: ProjectSettingsTarget): string {
  for (const host of project.hosts) {
    const hostLocalKey = resolveHostLocalProjectKey(host);
    if (hostLocalKey) return hostLocalKey;
  }
  return project.projectKey;
}

export function findProjectSettingsTarget<T extends ProjectSettingsTarget>(
  projects: readonly T[],
  routeKey: string,
): T | undefined {
  return (
    projects.find((project) => project.projectKey === routeKey) ??
    projects.find((project) =>
      project.hosts.some((host) => resolveHostLocalProjectKey(host) === routeKey),
    )
  );
}
