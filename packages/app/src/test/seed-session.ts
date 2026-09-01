import {
  useSessionStore,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { DirectorySync } from "@/runtime/directory-sync";
import {
  acceptProjectSnapshot,
  acceptWorkspaceSnapshots,
  removeWorkspaceSnapshot,
  registerDefaultSessionDataOwner,
  SessionDataOwner,
} from "@/runtime/session-data";

function projectFromWorkspace(workspace: WorkspaceDescriptor): ProjectDescriptor {
  return {
    projectId: workspace.projectId,
    // A daemon always derives a key for every project, so fixtures carry one too.
    // Same key on two hosts means the same project, which is what grouping asserts.
    projectKey: workspace.projectId,
    projectDisplayName: workspace.projectDisplayName,
    projectCustomName: workspace.projectCustomName ?? null,
    projectRootPath: workspace.projectRootPath,
    projectKind: workspace.projectKind,
  };
}

function collectProjects(
  workspaces: Iterable<WorkspaceDescriptor>,
  projects: Iterable<ProjectDescriptor> = [],
): Map<string, ProjectDescriptor> {
  const byProjectId = new Map(Array.from(projects, (project) => [project.projectId, project]));
  for (const workspace of workspaces) {
    if (!byProjectId.has(workspace.projectId)) {
      byProjectId.set(workspace.projectId, projectFromWorkspace(workspace));
    }
  }
  return byProjectId;
}

/**
 * Seeds a session the way a daemon populates it: every workspace's project is
 * published on the project channel, so the store never holds a workspace whose
 * project is unknown. Tests that seed workspaces alone model a state the daemon
 * cannot produce, and nothing renders.
 */
export function seedSessionWorkspaces(
  serverId: string,
  workspaces: Map<string, WorkspaceDescriptor>,
  projects?: Iterable<ProjectDescriptor>,
): void {
  const byProjectId = collectProjects(workspaces.values(), projects);
  const store = useSessionStore.getState();
  store.setProjects(serverId, byProjectId.values());
  store.setWorkspaces(serverId, workspaces);
}

export function publishSessionWorkspaces(
  serverId: string,
  workspaces: Map<string, WorkspaceDescriptor>,
  projects?: Iterable<ProjectDescriptor>,
): void {
  const byProjectId = collectProjects(workspaces.values(), projects);
  for (const workspaceId of useSessionStore.getState().sessions[serverId]?.workspaces.keys() ??
    []) {
    if (!workspaces.has(workspaceId)) removeWorkspaceSnapshot(serverId, workspaceId);
  }
  for (const project of byProjectId.values()) acceptProjectSnapshot(serverId, project);
  acceptWorkspaceSnapshots(serverId, Array.from(workspaces.values()));
}

export function installSessionDataTestOwner(serverIds: readonly string[]): SessionDataOwner {
  const owner = new SessionDataOwner();
  for (const serverId of serverIds) {
    owner.registerDirectory(
      serverId,
      new DirectorySync(serverId, {
        onAgentStoppedRunning: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      }),
    );
  }
  registerDefaultSessionDataOwner(owner);
  return owner;
}
