import type { EmptyProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import { buildHostProjectList, type HostProjectListItem } from "@/projects/host-project-model";
import { buildWorkspaceStructureProjects } from "@/projects/workspace-structure";
import { resolveProjectGroupKey } from "@/projects/project-group-key";

export interface WorkspaceSummary {
  id: string;
  name: string;
  title?: string;
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  status: WorkspaceDescriptor["status"];
  currentBranch: string | null;
  archivingAt?: string;
}

export interface ProjectHostEntry {
  serverId: string;
  projectId?: string;
  projectName: string;
  projectCustomName: string | null;
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
  /** Project parents with no active workspaces, so they still surface as projects. */
  emptyProjects?: EmptyProjectDescriptor[];
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
  projectId: string;
  projectName: string;
  projectCustomName: string | null;
  serverName: string;
  isOnline: boolean;
  workspaces: WorkspaceDescriptor[];
  // Repo root for a project parent that has no workspaces yet. Without it the
  // host's repoRoot resolves to "" and the project reads as non-editable.
  fallbackRepoRoot: string;
}

interface ProjectGroup {
  projectKey: string;
  projectName: string;
  projectCustomName: string | null;
  hostsByServerId: Map<string, HostGroup>;
}

function findProjectMetadata(
  host: ProjectHost,
  projectKey: string,
): { customName: string | null; displayName: string } | null {
  for (const workspace of host.workspaces) {
    if (workspace.projectId === projectKey) {
      return {
        customName: workspace.projectCustomName ?? null,
        displayName: workspace.projectDisplayName,
      };
    }
  }
  const emptyProject = host.emptyProjects?.find((project) => project.projectId === projectKey);
  return emptyProject
    ? {
        customName: emptyProject.projectCustomName ?? null,
        displayName: emptyProject.projectDisplayName,
      }
    : null;
}

function buildHostProjectEntries(hosts: ProjectHost[]): HostProjectListItem[] {
  return buildHostProjectList({
    projects: buildWorkspaceStructureProjects({
      sessions: hosts.map((host) => ({
        serverId: host.serverId,
        workspaces: host.workspaces,
        emptyProjects: host.emptyProjects,
      })),
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

function resolveHostRepoRoot(group: HostGroup): string {
  return group.workspaces[0]?.projectRootPath ?? group.fallbackRepoRoot;
}

function toWorkspaceSummary(workspace: WorkspaceDescriptor): WorkspaceSummary {
  const currentBranch = workspace.gitRuntime?.currentBranch?.trim();
  return {
    id: workspace.id,
    name: workspace.name,
    ...(workspace.title ? { title: workspace.title } : {}),
    workspaceKind: workspace.workspaceKind,
    status: workspace.status,
    currentBranch: currentBranch && currentBranch !== "HEAD" ? currentBranch : null,
    ...(workspace.archivingAt ? { archivingAt: workspace.archivingAt } : {}),
  };
}

function toHostEntry(group: HostGroup): ProjectHostEntry {
  const repoRoot = resolveHostRepoRoot(group);
  const canonical =
    group.workspaces.find((workspace) => workspace.projectRootPath === repoRoot) ??
    group.workspaces[0];
  return {
    serverId: group.serverId,
    projectId: group.projectId,
    projectName: group.projectName,
    projectCustomName: group.projectCustomName,
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

function addHostProjects(
  groups: Map<string, ProjectGroup>,
  host: ProjectHost,
  hostProjects: HostProjectListItem[],
): void {
  const emptyRepoRootByProjectId = new Map(
    (host.emptyProjects ?? []).map((project) => [project.projectId, project.projectRootPath]),
  );

  for (const hostProject of hostProjects) {
    const placement = hostProject.hosts.find((entry) => entry.serverId === host.serverId);
    if (!placement) continue;
    const projectId = placement.projectId ?? hostProject.projectKey;
    const customName = findProjectMetadata(host, projectId);
    let group = groups.get(hostProject.projectKey);
    if (!group) {
      group = {
        projectKey: hostProject.projectKey,
        projectName: customName?.displayName ?? hostProject.projectName,
        projectCustomName: customName?.customName ?? null,
        hostsByServerId: new Map(),
      };
      groups.set(hostProject.projectKey, group);
    } else if (customName?.customName && !group.projectCustomName) {
      group.projectCustomName = customName.customName;
      group.projectName = customName.displayName;
    }

    if (!group.hostsByServerId.has(host.serverId)) {
      group.hostsByServerId.set(host.serverId, {
        serverId: host.serverId,
        projectId,
        projectName: customName?.displayName ?? hostProject.projectName,
        projectCustomName: customName?.customName ?? null,
        serverName: host.serverName,
        isOnline: host.isOnline,
        workspaces: [],
        fallbackRepoRoot: emptyRepoRootByProjectId.get(projectId) ?? "",
      });
    }
  }
}

function attachHostWorkspaces(
  groups: Map<string, ProjectGroup>,
  host: ProjectHost,
  hostProjects: HostProjectListItem[],
): void {
  const projectKeyByProjectId = new Map(
    hostProjects.flatMap((project) =>
      project.hosts
        .filter((placement) => placement.serverId === host.serverId && placement.projectId)
        .map((placement) => [placement.projectId!, project.projectKey] as const),
    ),
  );

  for (const workspace of host.workspaces) {
    const key =
      projectKeyByProjectId.get(workspace.projectId) ??
      resolveProjectGroupKey({
        serverId: host.serverId,
        projectId: workspace.projectId,
        projectGroupKey: workspace.projectGroupKey,
      });
    groups.get(key)?.hostsByServerId.get(host.serverId)?.workspaces.push(workspace);
  }
}

export function buildProjects(input: BuildProjectsInput): BuildProjectsResult {
  const groups = new Map<string, ProjectGroup>();
  const projectEntries = buildHostProjectEntries(input.hosts);

  for (const host of input.hosts) {
    const hostProjects = projectEntries.filter((project) =>
      project.hosts.some((placement) => placement.serverId === host.serverId),
    );
    addHostProjects(groups, host, hostProjects);
    attachHostWorkspaces(groups, host, hostProjects);
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
