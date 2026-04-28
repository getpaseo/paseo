import type { WorkspaceDescriptor } from "@/stores/session-store";

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
  hosts: ProjectHostEntry[];
  totalWorkspaceCount: number;
  hostCount: number;
  onlineHostCount: number;
  githubUrl?: string;
  hiddenUnsupportedRemoteCount: number;
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
  hiddenUnsupportedRemoteCount: number;
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
  hostsByServerId: Map<string, HostGroup>;
}

function isSupportedProjectKey(projectKey: string): boolean {
  return !projectKey.startsWith("remote:") || projectKey.startsWith("remote:github.com/");
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

function toProjectSummary(input: {
  draft: ProjectGroup;
  hiddenUnsupportedRemoteCount: number;
}): ProjectSummary {
  const hosts = Array.from(input.draft.hostsByServerId.values())
    .map(toHostEntry)
    .sort(compareHosts);
  const totalWorkspaceCount = hosts.reduce((sum, host) => sum + host.workspaceCount, 0);
  const onlineHostCount = hosts.filter((host) => host.isOnline).length;
  return {
    projectKey: input.draft.projectKey,
    projectName: input.draft.projectName,
    hosts,
    totalWorkspaceCount,
    hostCount: hosts.length,
    onlineHostCount,
    githubUrl: deriveGithubUrl(input.draft.projectKey),
    hiddenUnsupportedRemoteCount: input.hiddenUnsupportedRemoteCount,
  };
}

export function buildProjects(input: BuildProjectsInput): BuildProjectsResult {
  const groups = new Map<string, ProjectGroup>();
  let hiddenUnsupportedRemoteCount = 0;

  for (const host of input.hosts) {
    for (const workspace of host.workspaces) {
      const projectKey = workspace.projectId;
      if (!isSupportedProjectKey(projectKey)) {
        hiddenUnsupportedRemoteCount += 1;
        continue;
      }

      let group = groups.get(projectKey);
      if (!group) {
        group = {
          projectKey,
          projectName: workspace.projectDisplayName,
          hostsByServerId: new Map(),
        };
        groups.set(projectKey, group);
      }

      let hostGroup = group.hostsByServerId.get(host.serverId);
      if (!hostGroup) {
        hostGroup = {
          serverId: host.serverId,
          serverName: host.serverName,
          isOnline: host.isOnline,
          workspaces: [],
        };
        group.hostsByServerId.set(host.serverId, hostGroup);
      }
      hostGroup.workspaces.push(workspace);
    }
  }

  const projects = Array.from(groups.values()).map((draft) =>
    toProjectSummary({ draft, hiddenUnsupportedRemoteCount }),
  );
  projects.sort((left, right) => {
    const name = left.projectName.localeCompare(right.projectName);
    if (name !== 0) {
      return name;
    }
    return left.projectKey.localeCompare(right.projectKey);
  });

  return {
    projects,
    hiddenUnsupportedRemoteCount,
  };
}
