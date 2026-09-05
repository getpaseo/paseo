import equal from "fast-deep-equal";
import type {
  ScriptStatusUpdateMessage,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import {
  clearWorkspaceArchivePending,
  shouldSuppressWorkspaceForLocalArchive,
} from "@/contexts/session-workspace-upserts";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";

export type WorkspaceDirectoryDelta =
  | Extract<SessionOutboundMessage, { type: "workspace_update" | "project.update" }>["payload"]
  | { kind: "script_status"; update: ScriptStatusUpdateMessage["payload"] };
type ProjectDirectoryDelta = Extract<SessionOutboundMessage, { type: "project.update" }>["payload"];

export interface WorkspaceDirectorySnapshot {
  workspaces: Map<string, WorkspaceDescriptor>;
  projects: Map<string, ProjectDescriptor>;
  syncCursors?: Partial<
    Record<"projects" | "workspaces", { generation: string; afterSeq: number }>
  >;
}

function patchWorkspaceScripts(
  workspaces: Map<string, WorkspaceDescriptor>,
  update: ScriptStatusUpdateMessage["payload"],
): Map<string, WorkspaceDescriptor> {
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: update.workspaceId,
  });
  if (!workspaceKey) return workspaces;
  const existing = workspaces.get(workspaceKey);
  if (!existing || equal(existing.scripts, update.scripts)) return workspaces;
  const next = new Map(workspaces);
  next.set(workspaceKey, {
    ...existing,
    scripts: update.scripts.map((script) => ({ ...script })),
  });
  return next;
}

function applyProjectDelta(
  snapshot: WorkspaceDirectorySnapshot,
  delta: ProjectDirectoryDelta,
): void {
  if (delta.kind === "remove") {
    snapshot.projects.delete(delta.projectId);
    for (const [workspaceId, workspace] of snapshot.workspaces) {
      if (workspace.projectId === delta.projectId) snapshot.workspaces.delete(workspaceId);
    }
    return;
  }

  const project = normalizeProjectDescriptor(delta.project);
  snapshot.projects.set(project.projectId, project);
  for (const [workspaceId, workspace] of snapshot.workspaces) {
    if (workspace.projectId !== project.projectId) continue;
    snapshot.workspaces.set(workspaceId, {
      ...workspace,
      projectDisplayName: project.projectDisplayName,
      projectCustomName: project.projectCustomName,
      projectCustomIconRevision: project.projectCustomIconRevision,
      projectRootPath: project.projectRootPath,
      projectKind: project.projectKind,
    });
  }
}

export class WorkspaceDirectoryReplica {
  constructor(private readonly serverId: string) {}

  applyDelta(delta: WorkspaceDirectoryDelta): void {
    const state = this.reconcile(this.read(), [delta]);
    this.commit(state, delta.kind === "remove" && "id" in delta ? [delta.id] : []);
  }

  commitCached(input: {
    workspaces: Map<string, WorkspaceDescriptor>;
    projects: Map<string, ProjectDescriptor>;
  }): void {
    this.commit(input, []);
    useSessionStore.getState().setHasWorkspaceDirectorySnapshot(this.serverId, true);
  }

  commitCachedWorkspace(
    workspace: WorkspaceDescriptor,
    project: ProjectDescriptor | undefined,
  ): void {
    if (shouldSuppressWorkspaceForLocalArchive({ serverId: this.serverId, workspace })) return;
    const snapshot = this.read();
    snapshot.workspaces.set(workspace.id, workspace);
    if (project) snapshot.projects.set(project.projectId, project);
    this.commit(snapshot, []);
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
      projects: new Map(session?.projects),
    };
  }

  private reconcile(
    snapshot: WorkspaceDirectorySnapshot,
    deltas: readonly WorkspaceDirectoryDelta[],
  ): WorkspaceDirectorySnapshot {
    let workspaces = new Map(snapshot.workspaces);
    const projects = new Map(snapshot.projects);
    for (const [workspaceId, workspace] of workspaces) {
      if (shouldSuppressWorkspaceForLocalArchive({ serverId: this.serverId, workspace })) {
        workspaces.delete(workspaceId);
      }
    }
    for (const delta of deltas) {
      if (delta.kind === "script_status") {
        workspaces = patchWorkspaceScripts(workspaces, delta.update);
        continue;
      }
      if ("projectId" in delta || "project" in delta) {
        applyProjectDelta({ workspaces, projects }, delta);
        continue;
      }
      if (delta.kind === "remove") {
        workspaces.delete(delta.id);
        if (delta.emptyProject) {
          const project = normalizeProjectDescriptor(delta.emptyProject);
          projects.set(project.projectId, project);
        }
        if (delta.removedProjectId) {
          projects.delete(delta.removedProjectId);
        }
        continue;
      }
      const workspace = normalizeWorkspaceDescriptor(delta.workspace);
      if (shouldSuppressWorkspaceForLocalArchive({ serverId: this.serverId, workspace })) {
        workspaces.delete(workspace.id);
      } else {
        workspaces.set(workspace.id, workspace);
      }
    }
    return { workspaces, projects };
  }

  private commit(snapshot: WorkspaceDirectorySnapshot, removedWorkspaceIds: string[]): void {
    const store = useSessionStore.getState();
    store.setWorkspaces(this.serverId, snapshot.workspaces);
    store.setProjects(this.serverId, snapshot.projects.values());
    for (const workspaceId of removedWorkspaceIds) {
      clearWorkspaceArchivePending({ serverId: this.serverId, workspaceId });
      useWorkspaceSetupStore.getState().removeWorkspace({ serverId: this.serverId, workspaceId });
    }
  }
}
