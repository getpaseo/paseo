import {
  canCreateWorkspaceForHostProject,
  type HostProjectListItem,
} from "@/projects/host-projects";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

export interface NewWorkspaceInitialServerInput {
  allServerIds: readonly string[];
  routeServerId: string | null | undefined;
  lastActiveProject: HostProjectListItem | null;
  projects: readonly HostProjectListItem[];
  hostConnectionStatusByServerId: ReadonlyMap<string, HostRuntimeConnectionStatus>;
  workspaceMultiplicityByServerId: ReadonlyMap<string, boolean>;
}

function knownServerId(serverIds: ReadonlySet<string>, serverId: string | null | undefined) {
  const normalized = serverId?.trim() ?? "";
  return normalized && serverIds.has(normalized) ? normalized : null;
}

function supportsAllProjects(
  workspaceMultiplicityByServerId: ReadonlyMap<string, boolean>,
  serverId: string,
) {
  return workspaceMultiplicityByServerId.get(serverId) === true;
}

function getProjectForServer(input: {
  candidate: HostProjectListItem;
  projects: readonly HostProjectListItem[];
  serverId: string;
}) {
  return (
    input.projects.find(
      (project) =>
        project.projectKey === input.candidate.projectKey &&
        project.hosts.some((host) => host.serverId === input.serverId),
    ) ?? input.candidate
  );
}

function canUseProjectForServer(input: {
  project: HostProjectListItem;
  projects: readonly HostProjectListItem[];
  serverId: string;
  workspaceMultiplicityByServerId: ReadonlyMap<string, boolean>;
}) {
  const project = getProjectForServer({
    candidate: input.project,
    projects: input.projects,
    serverId: input.serverId,
  });
  return canCreateWorkspaceForHostProject({
    project,
    serverId: input.serverId,
    allowAllProjects: supportsAllProjects(input.workspaceMultiplicityByServerId, input.serverId),
  });
}

function findLastActiveProjectServerId(input: {
  serverIds: ReadonlySet<string>;
  lastActiveProject: HostProjectListItem | null;
  projects: readonly HostProjectListItem[];
  workspaceMultiplicityByServerId: ReadonlyMap<string, boolean>;
}) {
  if (!input.lastActiveProject) {
    return null;
  }

  for (const host of input.lastActiveProject.hosts) {
    if (!input.serverIds.has(host.serverId)) {
      continue;
    }
    if (
      canUseProjectForServer({
        project: input.lastActiveProject,
        projects: input.projects,
        serverId: host.serverId,
        workspaceMultiplicityByServerId: input.workspaceMultiplicityByServerId,
      })
    ) {
      return host.serverId;
    }
  }

  return null;
}

function hasSelectableProject(input: {
  projects: readonly HostProjectListItem[];
  serverId: string;
  workspaceMultiplicityByServerId: ReadonlyMap<string, boolean>;
}) {
  return input.projects.some((project) =>
    canUseProjectForServer({
      project,
      projects: input.projects,
      serverId: input.serverId,
      workspaceMultiplicityByServerId: input.workspaceMultiplicityByServerId,
    }),
  );
}

export function resolveNewWorkspaceInitialServerId(input: NewWorkspaceInitialServerInput): string {
  const serverIds = new Set(input.allServerIds);
  const routeServerId = knownServerId(serverIds, input.routeServerId);
  if (routeServerId) {
    return routeServerId;
  }

  const lastActiveProjectServerId = findLastActiveProjectServerId({
    serverIds,
    lastActiveProject: input.lastActiveProject,
    projects: input.projects,
    workspaceMultiplicityByServerId: input.workspaceMultiplicityByServerId,
  });
  if (lastActiveProjectServerId) {
    return lastActiveProjectServerId;
  }

  const onlineServerIds = input.allServerIds.filter(
    (serverId) => input.hostConnectionStatusByServerId.get(serverId) === "online",
  );
  const onlineServerIdsWithProjects = onlineServerIds.filter((serverId) =>
    hasSelectableProject({
      projects: input.projects,
      serverId,
      workspaceMultiplicityByServerId: input.workspaceMultiplicityByServerId,
    }),
  );
  const serverIdsWithProjects = input.allServerIds.filter((serverId) =>
    hasSelectableProject({
      projects: input.projects,
      serverId,
      workspaceMultiplicityByServerId: input.workspaceMultiplicityByServerId,
    }),
  );

  if (onlineServerIdsWithProjects.length === 1) {
    return onlineServerIdsWithProjects[0] ?? "";
  }
  if (serverIdsWithProjects.length === 1) {
    return serverIdsWithProjects[0] ?? "";
  }
  if (onlineServerIds.length === 1) {
    return onlineServerIds[0] ?? "";
  }

  return input.allServerIds[0] ?? "";
}
