import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  normalizeEmptyProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type EmptyProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import {
  clearWorkspaceArchivePending,
  shouldSuppressWorkspaceForLocalArchive,
} from "@/contexts/session-workspace-upserts";

export type WorkspaceDirectoryDelta = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" | "project.update" }
>["payload"];
type ProjectDirectoryDelta = Extract<SessionOutboundMessage, { type: "project.update" }>["payload"];

export interface WorkspaceDirectorySnapshot {
  workspaces: Map<string, WorkspaceDescriptor>;
  emptyProjects: Map<string, EmptyProjectDescriptor>;
}

function applyProjectDelta(
  snapshot: WorkspaceDirectorySnapshot,
  delta: ProjectDirectoryDelta,
): void {
  if (delta.kind === "remove") {
    snapshot.emptyProjects.delete(delta.projectId);
    for (const [workspaceId, workspace] of snapshot.workspaces) {
      if (workspace.projectId === delta.projectId) snapshot.workspaces.delete(workspaceId);
    }
    return;
  }

  const project = normalizeEmptyProjectDescriptor(delta.project);
  let hasAttachedWorkspace = false;
  for (const [workspaceId, workspace] of snapshot.workspaces) {
    if (workspace.projectId !== project.projectId) continue;
    hasAttachedWorkspace = true;
    snapshot.workspaces.set(workspaceId, {
      ...workspace,
      projectDisplayName: project.projectDisplayName,
      projectCustomName: project.projectCustomName,
      projectRootPath: project.projectRootPath,
      projectKind: project.projectKind,
    });
  }
  if (hasAttachedWorkspace) snapshot.emptyProjects.delete(project.projectId);
  else snapshot.emptyProjects.set(project.projectId, project);
}

export class WorkspaceDirectoryReplica {
  constructor(private readonly serverId: string) {}

  applyDelta(delta: WorkspaceDirectoryDelta): void {
    const state = this.reconcile(this.read(), [delta]);
    this.commit(state, delta.kind === "remove" && "id" in delta ? [delta.id] : []);
  }

  commitSnapshot(
    snapshot: WorkspaceDirectorySnapshot,
    deltas: readonly WorkspaceDirectoryDelta[],
  ): void {
    const removedWorkspaceIds = deltas.flatMap((delta) =>
      delta.kind === "remove" && "id" in delta ? [delta.id] : [],
    );
    this.commit(this.reconcile(snapshot, deltas), removedWorkspaceIds);
    useSessionStore.getState().setHasHydratedWorkspaces(this.serverId, true);
  }

  private read(): WorkspaceDirectorySnapshot {
    const session = useSessionStore.getState().sessions[this.serverId];
    return {
      workspaces: new Map(session?.workspaces),
      emptyProjects: new Map(session?.emptyProjects),
    };
  }

  private reconcile(
    snapshot: WorkspaceDirectorySnapshot,
    deltas: readonly WorkspaceDirectoryDelta[],
  ): WorkspaceDirectorySnapshot {
    const workspaces = new Map(snapshot.workspaces);
    const emptyProjects = new Map(snapshot.emptyProjects);
    for (const [workspaceId, workspace] of workspaces) {
      if (shouldSuppressWorkspaceForLocalArchive({ serverId: this.serverId, workspace })) {
        workspaces.delete(workspaceId);
      }
    }
    for (const delta of deltas) {
      if ("projectId" in delta || "project" in delta) {
        applyProjectDelta({ workspaces, emptyProjects }, delta);
        continue;
      }
      if (delta.kind === "remove") {
        workspaces.delete(delta.id);
        if (delta.emptyProject) {
          const project = normalizeEmptyProjectDescriptor(delta.emptyProject);
          emptyProjects.set(project.projectId, project);
        }
        if (delta.removedProjectId) emptyProjects.delete(delta.removedProjectId);
        continue;
      }
      const workspace = normalizeWorkspaceDescriptor(delta.workspace);
      if (shouldSuppressWorkspaceForLocalArchive({ serverId: this.serverId, workspace })) {
        workspaces.delete(workspace.id);
      } else {
        workspaces.set(workspace.id, workspace);
        emptyProjects.delete(workspace.projectId);
      }
    }
    return { workspaces, emptyProjects };
  }

  private commit(snapshot: WorkspaceDirectorySnapshot, removedWorkspaceIds: string[]): void {
    const store = useSessionStore.getState();
    store.setWorkspaces(this.serverId, snapshot.workspaces);
    store.setEmptyProjects(this.serverId, snapshot.emptyProjects.values());
    for (const workspaceId of removedWorkspaceIds) {
      clearWorkspaceArchivePending({ serverId: this.serverId, workspaceId });
      useWorkspaceSetupStore.getState().removeWorkspace({ serverId: this.serverId, workspaceId });
    }
  }
}
