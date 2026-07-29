import { frameHostProjectKey } from "./project-key";

interface ProjectSettingsTarget {
  projectKey: string;
  hosts: ReadonlyArray<{ serverId: string; projectId?: string; isOnline?: boolean }>;
}

export function resolveHostProjectSettingsRouteKey(host: {
  serverId: string;
  projectId?: string;
}): string | null {
  const projectId = host.projectId;
  if (!projectId?.trim()) return null;
  return frameHostProjectKey({ serverId: host.serverId, projectId });
}

export function resolveProjectSettingsRouteKey(project: ProjectSettingsTarget): string {
  for (const host of project.hosts) {
    if (!host.isOnline) continue;
    const hostLocalKey = resolveHostProjectSettingsRouteKey(host);
    if (hostLocalKey) return hostLocalKey;
  }
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

export function resolveProjectSettingsServerId(input: {
  projectKey: string;
  editableServerIds: readonly string[];
  routedServerId: string | null;
  hostSelection: { routeKey: string; serverId: string };
}): string {
  const editableServerIds = new Set(input.editableServerIds);
  if (
    input.hostSelection.routeKey === input.projectKey &&
    editableServerIds.has(input.hostSelection.serverId)
  ) {
    return input.hostSelection.serverId;
  }
  if (input.routedServerId) return input.routedServerId;
  return input.editableServerIds[0] ?? "";
}
