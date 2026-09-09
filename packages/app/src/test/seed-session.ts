import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { defaultHostAppearance } from "@/hosts/appearance";
import {
  useSessionStore,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";

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
  const byProjectId = new Map<string, ProjectDescriptor>();
  for (const project of projects ?? []) byProjectId.set(project.projectId, project);
  for (const workspace of workspaces.values()) {
    if (!byProjectId.has(workspace.projectId)) {
      byProjectId.set(workspace.projectId, projectFromWorkspace(workspace));
    }
  }
  const store = useSessionStore.getState();
  store.setProjects(serverId, byProjectId.values());
  store.setWorkspaces(serverId, workspaces);
}

export function seedSessionHosts(serverIds: readonly string[]): void {
  getHostRuntimeStore().syncHosts(
    serverIds.map((serverId) => ({
      serverId,
      label: serverId,
      appearance: defaultHostAppearance(),
      lifecycle: {},
      connections: [],
      preferredConnectionId: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    })),
  );
}

export function seedRuntimeWorkspaces(
  serverId: string,
  workspaces: Map<string, WorkspaceDescriptor>,
): void {
  const runtime = getHostRuntimeStore();
  for (const id of useSessionStore.getState().sessions[serverId]?.workspaces.keys() ?? []) {
    if (!workspaces.has(id)) runtime.removeWorkspaceSnapshot(serverId, id);
  }
  for (const workspace of workspaces.values()) {
    runtime.acceptProjectSnapshot(serverId, projectFromWorkspace(workspace));
  }
  runtime.acceptWorkspaceSnapshots(serverId, [...workspaces.values()]);
}
