import type { TaskCard } from "@getpaseo/protocol/tasks/types";
import type { ProjectSummary } from "@/utils/projects";

export const MASTER_BACKLOG_ALL_HOSTS_FAILED_MESSAGE =
  "No connected hosts could load backlog tasks";

const PROJECT_OPTION_PREFIX = "backlog-project:";

export interface MasterBacklogProjectTarget {
  optionId: string;
  serverId: string;
  serverName: string;
  projectId: string;
  projectName: string;
  repoRoot: string;
}

export interface MasterBacklogTask extends TaskCard {
  taskKey: string;
  serverId: string;
  serverName: string;
  projectName: string;
  projectRootPath: string | null;
}

export interface MasterBacklogHostInput {
  serverId: string;
  serverName: string;
}

export interface MasterBacklogHostTasks {
  serverId: string;
  serverName: string;
  tasks: TaskCard[];
}

export interface MasterBacklogHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface MasterBacklogRuntimeSnapshot {
  connectionStatus: string;
}

export interface MasterBacklogClient {
  listAllTasks(): Promise<{ tasks: TaskCard[]; error: string | null }>;
}

export interface MasterBacklogRuntime {
  getClient(serverId: string): MasterBacklogClient | null;
  getSnapshot(serverId: string): MasterBacklogRuntimeSnapshot | null | undefined;
}

export interface FetchMasterBacklogTasksResult {
  hostTasks: MasterBacklogHostTasks[];
  hostErrors: MasterBacklogHostError[];
}

export function buildMasterBacklogProjectOptionId(serverId: string, projectId: string): string {
  return `${PROJECT_OPTION_PREFIX}${serverId}:${projectId}`;
}

function projectMetadataKey(serverId: string, projectId: string): string {
  return `${serverId}:${projectId}`;
}

function compareMasterBacklogProjectTargets(
  left: MasterBacklogProjectTarget,
  right: MasterBacklogProjectTarget,
): number {
  return (
    left.projectName.localeCompare(right.projectName, undefined, {
      numeric: true,
      sensitivity: "base",
    }) ||
    left.serverName.localeCompare(right.serverName, undefined, {
      numeric: true,
      sensitivity: "base",
    }) ||
    left.projectId.localeCompare(right.projectId) ||
    left.serverId.localeCompare(right.serverId)
  );
}

export function buildMasterBacklogProjectTargets(input: {
  projects: readonly ProjectSummary[];
  supportsBacklogByServerId: ReadonlyMap<string, boolean>;
}): MasterBacklogProjectTarget[] {
  const targets: MasterBacklogProjectTarget[] = [];
  for (const project of input.projects) {
    for (const host of project.hosts) {
      const repoRoot = host.repoRoot.trim();
      if (!host.isOnline || !repoRoot || !input.supportsBacklogByServerId.get(host.serverId)) {
        continue;
      }
      targets.push({
        optionId: buildMasterBacklogProjectOptionId(host.serverId, project.projectKey),
        serverId: host.serverId,
        serverName: host.serverName,
        projectId: project.projectKey,
        projectName: project.projectName,
        repoRoot,
      });
    }
  }
  return targets.sort(compareMasterBacklogProjectTargets);
}

export function annotateMasterBacklogTasks(input: {
  hostTasks: readonly MasterBacklogHostTasks[];
  projects: readonly ProjectSummary[];
}): MasterBacklogTask[] {
  const metadataByProject = new Map<
    string,
    {
      projectName: string;
      repoRoot: string | null;
    }
  >();

  for (const project of input.projects) {
    for (const host of project.hosts) {
      metadataByProject.set(projectMetadataKey(host.serverId, project.projectKey), {
        projectName: project.projectName,
        repoRoot: host.repoRoot.trim() || null,
      });
    }
  }

  const tasks: MasterBacklogTask[] = [];
  for (const host of input.hostTasks) {
    for (const task of host.tasks) {
      const metadata = metadataByProject.get(projectMetadataKey(host.serverId, task.projectId));
      tasks.push({
        ...task,
        taskKey: `${host.serverId}:${task.projectId}:${task.id}`,
        serverId: host.serverId,
        serverName: host.serverName,
        projectName: metadata?.projectName ?? task.projectId,
        projectRootPath: metadata?.repoRoot ?? null,
      });
    }
  }
  return tasks;
}

export function sortMasterBacklogTasks(tasks: readonly MasterBacklogTask[]): MasterBacklogTask[] {
  return [...tasks].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === "active" ? -1 : 1;
    }
    const updatedDelta = right.updatedAt.localeCompare(left.updatedAt);
    if (updatedDelta !== 0) {
      return updatedDelta;
    }
    return (
      left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: "base" }) ||
      left.projectName.localeCompare(right.projectName, undefined, {
        numeric: true,
        sensitivity: "base",
      }) ||
      left.serverName.localeCompare(right.serverName, undefined, {
        numeric: true,
        sensitivity: "base",
      }) ||
      left.id.localeCompare(right.id)
    );
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function fetchMasterBacklogTasks(input: {
  hosts: readonly MasterBacklogHostInput[];
  runtime: MasterBacklogRuntime;
}): Promise<FetchMasterBacklogTasksResult> {
  const hostTasks: MasterBacklogHostTasks[] = [];
  const hostErrors: MasterBacklogHostError[] = [];
  let connectedAttempts = 0;

  await Promise.all(
    input.hosts.map(async (host) => {
      const snapshot = input.runtime.getSnapshot(host.serverId);
      const isOnline = snapshot?.connectionStatus === "online";
      const client = input.runtime.getClient(host.serverId);
      if (!client || !isOnline) {
        return;
      }

      connectedAttempts += 1;
      try {
        const payload = await client.listAllTasks();
        if (payload.error) {
          throw new Error(payload.error);
        }
        hostTasks.push({
          serverId: host.serverId,
          serverName: host.serverName,
          tasks: payload.tasks,
        });
      } catch (error) {
        hostErrors.push({
          serverId: host.serverId,
          serverName: host.serverName,
          message: toErrorMessage(error),
        });
      }
    }),
  );

  if (connectedAttempts > 0 && hostTasks.length === 0 && hostErrors.length === connectedAttempts) {
    throw new Error(MASTER_BACKLOG_ALL_HOSTS_FAILED_MESSAGE);
  }

  return { hostTasks, hostErrors };
}

export function matchesBacklogSearchQuery(
  task: {
    title: string;
    description: string;
    projectName?: string | null;
    serverName?: string | null;
    projectId?: string | null;
  },
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const haystack = [
    task.title,
    task.description,
    task.projectName ?? "",
    task.serverName ?? "",
    task.projectId ?? "",
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(normalized);
}

export function filterBacklogTasksByQuery<
  T extends {
    title: string;
    description: string;
    projectName?: string | null;
    serverName?: string | null;
    projectId?: string | null;
  },
>(tasks: readonly T[], query: string): T[] {
  const normalized = query.trim();
  if (!normalized) {
    return [...tasks];
  }
  return tasks.filter((task) => matchesBacklogSearchQuery(task, normalized));
}
