import type { WorkspaceDescriptor } from "@/stores/session-store";
import { buildHostProjectList, type HostProjectListItem } from "@/projects/host-project-model";
import { buildWorkspaceStructureProjects } from "@/projects/workspace-structure";

export interface WorkspaceSummary {
  id: string;
  name: string;
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  status: WorkspaceDescriptor["status"];
  currentBranch: string | null;
}

export interface ProjectHostEntry {
  serverId: string;
  serverName: string;
  isOnline: boolean;
  repoRoot: string;
  workspaceCount: number;
  workspaces: WorkspaceSummary[];
  gitRuntime?: WorkspaceDescriptor["gitRuntime"];
  githubRuntime?: WorkspaceDescriptor["githubRuntime"];
}

export interface ProjectSummary {
  projectKey: string;
  projectName: string;
  projectCustomName?: string | null;
  hosts: ProjectHostEntry[];
  totalWorkspaceCount: number;
  hostCount: number;
  onlineHostCount: number;
  githubUrl?: string;
}

export interface ProjectHost {
  serverId: string;
  serverName: string;
  isOnline: boolean;
  workspaces: WorkspaceDescriptor[];
}

export interface BuildProjectsInput {
  hosts: ProjectHost[];
}

export interface BuildProjectsResult {
  projects: ProjectSummary[];
}

const GITHUB_PROJECT_KEY_PATTERN = /^remote:github\.com\/([^/]+)\/([^/]+)$/;

interface HostGroup {
  serverId: string;
  serverName: string;
  isOnline: boolean;
  workspaces: WorkspaceDescriptor[];
}

interface ProjectGroup {
  projectKey: string;
  projectName: string;
  projectCustomName: string | null;
  hostsByServerId: Map<string, HostGroup>;
}

function findProjectCustomName(
  workspaces: WorkspaceDescriptor[],
  projectKey: string,
): { customName: string; displayName: string } | null {
  for (const workspace of workspaces) {
    if (workspace.projectId === projectKey && workspace.projectCustomName) {
      return {
        customName: workspace.projectCustomName,
        displayName: workspace.projectDisplayName,
      };
    }
  }
  return null;
}

function buildHostProjectEntries(host: ProjectHost): HostProjectListItem[] {
  return buildHostProjectList({
    serverId: host.serverId,
    projects: buildWorkspaceStructureProjects({
      serverId: host.serverId,
      workspaces: host.workspaces,
    }),
  });
}

function deriveGithubUrl(projectKey: string): string | undefined {
  const match = projectKey.match(GITHUB_PROJECT_KEY_PATTERN);
  if (!match) {
    return undefined;
  }
  return `https://github.com/${match[1]}/${match[2]}`;
}

function resolveHostRepoRoot(workspaces: WorkspaceDescriptor[]): string {
  for (const workspace of workspaces) {
    const mainRepoRoot = workspace.project?.checkout.mainRepoRoot;
    if (mainRepoRoot) {
      return mainRepoRoot;
    }
  }
  return workspaces[0]?.projectRootPath ?? "";
}

function toWorkspaceSummary(workspace: WorkspaceDescriptor): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    workspaceKind: workspace.workspaceKind,
    status: workspace.status,
    currentBranch: workspace.gitRuntime?.currentBranch ?? null,
  };
}

function toHostEntry(group: HostGroup): ProjectHostEntry {
  const repoRoot = resolveHostRepoRoot(group.workspaces);
  const canonical =
    group.workspaces.find((workspace) => workspace.projectRootPath === repoRoot) ??
    group.workspaces[0];
  return {
    serverId: group.serverId,
    serverName: group.serverName,
    isOnline: group.isOnline,
    repoRoot,
    workspaceCount: group.workspaces.length,
    workspaces: group.workspaces.map(toWorkspaceSummary),
    gitRuntime: canonical?.gitRuntime,
    githubRuntime: canonical?.githubRuntime,
  };
}

function compareHosts(left: ProjectHostEntry, right: ProjectHostEntry): number {
  const name = left.serverName.localeCompare(right.serverName);
  if (name !== 0) {
    return name;
  }
  return left.serverId.localeCompare(right.serverId);
}

function toProjectSummary(draft: ProjectGroup): ProjectSummary {
  const hosts = Array.from(draft.hostsByServerId.values()).map(toHostEntry).sort(compareHosts);
  const totalWorkspaceCount = hosts.reduce((sum, host) => sum + host.workspaceCount, 0);
  const onlineHostCount = hosts.filter((host) => host.isOnline).length;
  return {
    projectKey: draft.projectKey,
    projectName: draft.projectName,
    projectCustomName: draft.projectCustomName,
    hosts,
    totalWorkspaceCount,
    hostCount: hosts.length,
    onlineHostCount,
    githubUrl: deriveGithubUrl(draft.projectKey),
  };
}

export function buildProjects(input: BuildProjectsInput): BuildProjectsResult {
  const groups = new Map<string, ProjectGroup>();

  for (const host of input.hosts) {
    const hostProjects = buildHostProjectEntries(host);
    for (const hostProject of hostProjects) {
      const customName = findProjectCustomName(host.workspaces, hostProject.projectKey);
      let group = groups.get(hostProject.projectKey);
      if (!group) {
        group = {
          projectKey: hostProject.projectKey,
          projectName: customName?.displayName ?? hostProject.projectName,
          projectCustomName: customName?.customName ?? null,
          hostsByServerId: new Map(),
        };
        groups.set(hostProject.projectKey, group);
      } else if (customName && !group.projectCustomName) {
        group.projectCustomName = customName.customName;
        group.projectName = customName.displayName;
      }

      if (!group.hostsByServerId.has(host.serverId)) {
        group.hostsByServerId.set(host.serverId, {
          serverId: host.serverId,
          serverName: host.serverName,
          isOnline: host.isOnline,
          workspaces: [],
        });
      }
    }

    for (const workspace of host.workspaces) {
      const group = groups.get(workspace.projectId);
      const hostGroup = group?.hostsByServerId.get(host.serverId);
      if (!hostGroup) continue;
      hostGroup.workspaces.push(workspace);
    }
  }

  const projects = Array.from(groups.values()).map(toProjectSummary);
  projects.sort((left, right) => {
    const name = left.projectName.localeCompare(right.projectName);
    if (name !== 0) {
      return name;
    }
    return left.projectKey.localeCompare(right.projectKey);
  });

  return { projects };
}
