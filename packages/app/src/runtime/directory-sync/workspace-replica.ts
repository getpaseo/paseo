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
import type { DirectoryReplicaMutation } from "@/runtime/replica-cache";

export type WorkspaceDirectoryDelta =
  | Extract<SessionOutboundMessage, { type: "workspace_update" | "project.update" }>["payload"]
  | { kind: "script_status"; update: ScriptStatusUpdateMessage["payload"] };

export interface WorkspaceDirectorySnapshot {
  workspaces: Map<string, WorkspaceDescriptor>;
  projects: Map<string, ProjectDescriptor>;
  syncCursors?: Partial<
    Record<"projects" | "workspaces", { generation: string; afterSeq: number }>
  >;
  syncModes?: Partial<Record<"projects" | "workspaces", "snapshot" | "changes">>;
  touchedWorkspaceIds?: Set<string>;
  touchedProjectIds?: Set<string>;
}

export class WorkspaceDirectoryReplica {
  private workspaces = new Map<string, WorkspaceDescriptor>();
  private projects = new Map<string, ProjectDescriptor>();
  private workspaceIdsByProject = new Map<string, Set<string>>();

  constructor(private readonly serverId: string) {}

  applyDelta(delta: WorkspaceDirectoryDelta): DirectoryReplicaMutation[] {
    if (delta.kind === "script_status") return this.applyScriptStatus(delta.update);
    if ("projectId" in delta || "project" in delta) return this.applyProjectDelta(delta);
    if (delta.kind === "remove") return this.removeWorkspace(delta);
    return this.upsertWorkspace(normalizeWorkspaceDescriptor(delta.workspace));
  }

  commitCached(input: {
    workspaces: Map<string, WorkspaceDescriptor>;
    projects: Map<string, ProjectDescriptor>;
  }): void {
    this.replace({
      workspaces: new Map([...input.workspaces, ...this.workspaces]),
      projects: new Map([...input.projects, ...this.projects]),
    });
    useSessionStore.getState().setHasWorkspaceDirectorySnapshot(this.serverId, true);
  }

  commitSnapshot(
    snapshot: WorkspaceDirectorySnapshot,
    deltas: readonly WorkspaceDirectoryDelta[],
  ): DirectoryReplicaMutation[] {
    this.replace(snapshot);
    const mutations = deltas.flatMap((delta) => this.applyDelta(delta));
    useSessionStore.getState().setHasHydratedWorkspaces(this.serverId, true);
    return mutations;
  }

  snapshot(): WorkspaceDirectorySnapshot {
    return { workspaces: this.workspaces, projects: this.projects };
  }

  acceptWorkspaces(workspaces: readonly WorkspaceDescriptor[]): DirectoryReplicaMutation[] {
    return workspaces.flatMap((workspace) => this.upsertWorkspace(workspace));
  }

  acceptProject(project: ProjectDescriptor): DirectoryReplicaMutation[] {
    this.setProject(project);
    return [{ kind: "project", type: "upsert", id: project.projectId, value: project }];
  }

  removeWorkspaceSnapshot(workspaceId: string): DirectoryReplicaMutation[] {
    this.deleteWorkspace(workspaceId);
    return [{ kind: "workspace", type: "delete", id: workspaceId }];
  }

  private replace(snapshot: WorkspaceDirectorySnapshot): void {
    const workspaces = new Map<string, WorkspaceDescriptor>();
    for (const [workspaceId, workspace] of snapshot.workspaces) {
      if (!shouldSuppressWorkspaceForLocalArchive({ serverId: this.serverId, workspace })) {
        workspaces.set(workspaceId, workspace);
      }
    }
    this.workspaces = workspaces;
    this.projects = new Map(snapshot.projects);
    this.rebuildProjectIndex();
    const store = useSessionStore.getState();
    store.setWorkspaces(this.serverId, this.workspaces);
    store.setProjects(this.serverId, this.projects.values());
  }

  private applyScriptStatus(
    update: ScriptStatusUpdateMessage["payload"],
  ): DirectoryReplicaMutation[] {
    const workspaceId = resolveWorkspaceMapKeyByIdentity({
      workspaces: this.workspaces,
      workspaceId: update.workspaceId,
    });
    const workspace = workspaceId ? this.workspaces.get(workspaceId) : undefined;
    if (!workspace || equal(workspace.scripts, update.scripts)) return [];
    const next = { ...workspace, scripts: update.scripts.map((script) => ({ ...script })) };
    this.setWorkspace(next);
    return [{ kind: "workspace", type: "upsert", id: next.id, value: next }];
  }

  private applyProjectDelta(
    delta: Extract<SessionOutboundMessage, { type: "project.update" }>["payload"],
  ): DirectoryReplicaMutation[] {
    if (delta.kind === "remove") {
      const mutations: DirectoryReplicaMutation[] = [
        { kind: "project", type: "delete", id: delta.projectId },
      ];
      this.projects.delete(delta.projectId);
      useSessionStore.getState().removeProject(this.serverId, delta.projectId);
      for (const workspaceId of this.workspaceIdsByProject.get(delta.projectId) ?? []) {
        this.deleteWorkspace(workspaceId);
        mutations.push({ kind: "workspace", type: "delete", id: workspaceId });
      }
      return mutations;
    }

    const project = normalizeProjectDescriptor(delta.project);
    this.setProject(project);
    const mutations: DirectoryReplicaMutation[] = [
      { kind: "project", type: "upsert", id: project.projectId, value: project },
    ];
    for (const workspaceId of this.workspaceIdsByProject.get(project.projectId) ?? []) {
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace) continue;
      const next = {
        ...workspace,
        projectDisplayName: project.projectDisplayName,
        projectCustomName: project.projectCustomName,
        projectCustomIconRevision: project.projectCustomIconRevision,
        projectRootPath: project.projectRootPath,
        projectKind: project.projectKind,
      };
      this.setWorkspace(next);
      mutations.push({ kind: "workspace", type: "upsert", id: next.id, value: next });
    }
    return mutations;
  }

  private removeWorkspace(
    delta: Extract<SessionOutboundMessage, { type: "workspace_update" }>["payload"] & {
      kind: "remove";
    },
  ): DirectoryReplicaMutation[] {
    this.deleteWorkspace(delta.id);
    const mutations: DirectoryReplicaMutation[] = [
      { kind: "workspace", type: "delete", id: delta.id },
    ];
    if (delta.emptyProject) {
      const project = normalizeProjectDescriptor(delta.emptyProject);
      this.setProject(project);
      mutations.push({ kind: "project", type: "upsert", id: project.projectId, value: project });
    }
    if (delta.removedProjectId) {
      this.projects.delete(delta.removedProjectId);
      useSessionStore.getState().removeProject(this.serverId, delta.removedProjectId);
      mutations.push({ kind: "project", type: "delete", id: delta.removedProjectId });
    }
    clearWorkspaceArchivePending({ serverId: this.serverId, workspaceId: delta.id });
    useWorkspaceSetupStore
      .getState()
      .removeWorkspace({ serverId: this.serverId, workspaceId: delta.id });
    return mutations;
  }

  private upsertWorkspace(workspace: WorkspaceDescriptor): DirectoryReplicaMutation[] {
    if (shouldSuppressWorkspaceForLocalArchive({ serverId: this.serverId, workspace })) {
      if (!this.workspaces.has(workspace.id)) return [];
      this.deleteWorkspace(workspace.id);
      return [{ kind: "workspace", type: "delete", id: workspace.id }];
    }
    this.setWorkspace(workspace);
    return [{ kind: "workspace", type: "upsert", id: workspace.id, value: workspace }];
  }

  private setWorkspace(workspace: WorkspaceDescriptor): void {
    const previous = this.workspaces.get(workspace.id);
    if (previous?.projectId !== workspace.projectId) {
      this.workspaceIdsByProject.get(previous?.projectId ?? "")?.delete(workspace.id);
    }
    this.workspaces.set(workspace.id, workspace);
    const projectWorkspaces = this.workspaceIdsByProject.get(workspace.projectId) ?? new Set();
    projectWorkspaces.add(workspace.id);
    this.workspaceIdsByProject.set(workspace.projectId, projectWorkspaces);
    useSessionStore.getState().mergeWorkspaces(this.serverId, [workspace]);
  }

  private deleteWorkspace(workspaceId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) this.workspaceIdsByProject.get(workspace.projectId)?.delete(workspaceId);
    this.workspaces.delete(workspaceId);
    useSessionStore.getState().removeWorkspace(this.serverId, workspaceId);
  }

  private setProject(project: ProjectDescriptor): void {
    this.projects.set(project.projectId, project);
    useSessionStore.getState().upsertProject(this.serverId, project);
  }

  private rebuildProjectIndex(): void {
    this.workspaceIdsByProject = new Map();
    for (const workspace of this.workspaces.values()) {
      const workspaceIds = this.workspaceIdsByProject.get(workspace.projectId) ?? new Set();
      workspaceIds.add(workspace.id);
      this.workspaceIdsByProject.set(workspace.projectId, workspaceIds);
    }
  }
}
