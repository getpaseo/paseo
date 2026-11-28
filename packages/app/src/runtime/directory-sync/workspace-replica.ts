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
  shouldSuppressWorkspaceRemovalForLocalUndo,
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

interface WorkspaceDeltaBatchState {
  upsertedWorkspaces: Map<string, WorkspaceDescriptor>;
  removedWorkspaceIds: Set<string>;
  upsertedProjects: Map<string, ProjectDescriptor>;
  removedProjectIds: Set<string>;
  mutationsByKey: Map<string, DirectoryReplicaMutation>;
}

export class WorkspaceDirectoryReplica {
  private workspaces = new Map<string, WorkspaceDescriptor>();
  private projects = new Map<string, ProjectDescriptor>();
  private workspaceIdsByProject = new Map<string, Set<string>>();

  constructor(private readonly serverId: string) {}

  applyDelta(delta: WorkspaceDirectoryDelta): DirectoryReplicaMutation[] {
    return this.applyDeltas([delta]);
  }

  applyDeltas(deltas: readonly WorkspaceDirectoryDelta[]): DirectoryReplicaMutation[] {
    if (deltas.length === 0) return [];
    const batch: WorkspaceDeltaBatchState = {
      upsertedWorkspaces: new Map(),
      removedWorkspaceIds: new Set(),
      upsertedProjects: new Map(),
      removedProjectIds: new Set(),
      mutationsByKey: new Map(),
    };
    for (const delta of deltas) {
      this.applyDeltaToBatch(delta, batch);
    }
    const store = useSessionStore.getState();
    for (const projectId of batch.removedProjectIds) store.removeProject(this.serverId, projectId);
    for (const project of batch.upsertedProjects.values()) {
      store.upsertProject(this.serverId, project);
    }
    for (const workspaceId of batch.removedWorkspaceIds) {
      store.removeWorkspace(this.serverId, workspaceId);
    }
    if (batch.upsertedWorkspaces.size > 0) {
      store.mergeWorkspaces(this.serverId, batch.upsertedWorkspaces.values());
    }
    return Array.from(batch.mutationsByKey.values());
  }

  private applyDeltaToBatch(delta: WorkspaceDirectoryDelta, batch: WorkspaceDeltaBatchState): void {
    if (delta.kind === "script_status") {
      this.applyScriptStatusToBatch(delta.update, batch);
      return;
    }
    if ("projectId" in delta || "project" in delta) {
      this.applyProjectDeltaToBatch(delta, batch);
      return;
    }
    if (delta.kind === "remove") {
      this.applyWorkspaceRemoveToBatch(delta, batch);
      return;
    }
    const workspace = normalizeWorkspaceDescriptor(delta.workspace);
    if (shouldSuppressWorkspaceForLocalArchive({ serverId: this.serverId, workspace })) {
      if (this.workspaces.has(workspace.id)) this.recordBatchWorkspaceDelete(workspace.id, batch);
      return;
    }
    this.recordBatchWorkspaceUpsert(workspace, batch);
  }

  private applyScriptStatusToBatch(
    update: ScriptStatusUpdateMessage["payload"],
    batch: WorkspaceDeltaBatchState,
  ): void {
    const workspaceId = resolveWorkspaceMapKeyByIdentity({
      workspaces: this.workspaces,
      workspaceId: update.workspaceId,
    });
    const workspace = workspaceId ? this.workspaces.get(workspaceId) : undefined;
    if (!workspace || equal(workspace.scripts, update.scripts)) return;
    this.recordBatchWorkspaceUpsert(
      {
        ...workspace,
        scripts: update.scripts.map((script) => ({ ...script })),
      },
      batch,
    );
  }

  private applyProjectDeltaToBatch(
    delta: Extract<SessionOutboundMessage, { type: "project.update" }>["payload"],
    batch: WorkspaceDeltaBatchState,
  ): void {
    if (delta.kind === "remove") {
      this.recordBatchProjectDelete(delta.projectId, batch);
      for (const workspaceId of Array.from(this.workspaceIdsByProject.get(delta.projectId) ?? [])) {
        this.recordBatchWorkspaceDelete(workspaceId, batch);
      }
      return;
    }
    const project = normalizeProjectDescriptor(delta.project);
    this.recordBatchProjectUpsert(project, batch);
    for (const workspaceId of this.workspaceIdsByProject.get(project.projectId) ?? []) {
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace) continue;
      this.recordBatchWorkspaceUpsert(
        {
          ...workspace,
          projectDisplayName: project.projectDisplayName,
          projectCustomName: project.projectCustomName,
          projectCustomIconRevision: project.projectCustomIconRevision,
          projectRootPath: project.projectRootPath,
          projectKind: project.projectKind,
        },
        batch,
      );
    }
  }

  private applyWorkspaceRemoveToBatch(
    delta: Extract<SessionOutboundMessage, { type: "workspace_update" }>["payload"] & {
      kind: "remove";
    },
    batch: WorkspaceDeltaBatchState,
  ): void {
    if (
      shouldSuppressWorkspaceRemovalForLocalUndo({
        serverId: this.serverId,
        workspaceId: delta.id,
      })
    ) {
      return;
    }
    this.recordBatchWorkspaceDelete(delta.id, batch);
    if (delta.emptyProject) {
      this.recordBatchProjectUpsert(normalizeProjectDescriptor(delta.emptyProject), batch);
    }
    if (delta.removedProjectId) {
      this.recordBatchProjectDelete(delta.removedProjectId, batch);
    }
    clearWorkspaceArchivePending({ serverId: this.serverId, workspaceId: delta.id });
    useWorkspaceSetupStore
      .getState()
      .removeWorkspace({ serverId: this.serverId, workspaceId: delta.id });
  }

  private recordBatchWorkspaceUpsert(
    workspace: WorkspaceDescriptor,
    batch: WorkspaceDeltaBatchState,
  ): void {
    this.applySetupStatus(workspace);
    const previous = this.workspaces.get(workspace.id);
    if (previous?.projectId !== workspace.projectId) {
      this.workspaceIdsByProject.get(previous?.projectId ?? "")?.delete(workspace.id);
    }
    this.workspaces.set(workspace.id, workspace);
    const projectWorkspaces = this.workspaceIdsByProject.get(workspace.projectId) ?? new Set();
    projectWorkspaces.add(workspace.id);
    this.workspaceIdsByProject.set(workspace.projectId, projectWorkspaces);
    batch.removedWorkspaceIds.delete(workspace.id);
    batch.upsertedWorkspaces.set(workspace.id, workspace);
    batch.mutationsByKey.set(`workspace:${workspace.id}`, {
      kind: "workspace",
      type: "upsert",
      id: workspace.id,
      value: workspace,
    });
  }

  private recordBatchWorkspaceDelete(workspaceId: string, batch: WorkspaceDeltaBatchState): void {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) this.workspaceIdsByProject.get(workspace.projectId)?.delete(workspaceId);
    this.workspaces.delete(workspaceId);
    batch.upsertedWorkspaces.delete(workspaceId);
    batch.removedWorkspaceIds.add(workspaceId);
    batch.mutationsByKey.set(`workspace:${workspaceId}`, {
      kind: "workspace",
      type: "delete",
      id: workspaceId,
    });
  }

  private recordBatchProjectUpsert(
    project: ProjectDescriptor,
    batch: WorkspaceDeltaBatchState,
  ): void {
    this.projects.set(project.projectId, project);
    batch.removedProjectIds.delete(project.projectId);
    batch.upsertedProjects.set(project.projectId, project);
    batch.mutationsByKey.set(`project:${project.projectId}`, {
      kind: "project",
      type: "upsert",
      id: project.projectId,
      value: project,
    });
  }

  private recordBatchProjectDelete(projectId: string, batch: WorkspaceDeltaBatchState): void {
    this.projects.delete(projectId);
    batch.upsertedProjects.delete(projectId);
    batch.removedProjectIds.add(projectId);
    batch.mutationsByKey.set(`project:${projectId}`, {
      kind: "project",
      type: "delete",
      id: projectId,
    });
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

  commitCachedWorkspace(
    workspace: WorkspaceDescriptor,
    project: ProjectDescriptor | undefined,
  ): void {
    if (shouldSuppressWorkspaceForLocalArchive({ serverId: this.serverId, workspace })) return;
    if (project) this.setProject(project);
    this.setWorkspace(workspace);
  }

  commitSnapshot(
    snapshot: WorkspaceDirectorySnapshot,
    deltas: readonly WorkspaceDirectoryDelta[],
  ): DirectoryReplicaMutation[] {
    this.replace(snapshot);
    const mutations = this.applyDeltas(deltas);
    useSessionStore.getState().setHasHydratedWorkspaces(this.serverId, true);
    return mutations;
  }

  snapshot(): WorkspaceDirectorySnapshot {
    return { workspaces: this.workspaces, projects: this.projects };
  }

  acceptWorkspaces(workspaces: readonly WorkspaceDescriptor[]): DirectoryReplicaMutation[] {
    // Creation responses and progress snapshots can arrive after live updates.
    // They seed missing rows; the directory owns rows it has already received.
    return workspaces.flatMap((workspace) => {
      if (this.workspaces.has(workspace.id)) return [];
      return this.upsertWorkspace(workspace);
    });
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
    // A snapshot taken while an undo runs can predate the restore; the host publishes the row.
    for (const [workspaceId, workspace] of this.workspaces) {
      if (
        !workspaces.has(workspaceId) &&
        shouldSuppressWorkspaceRemovalForLocalUndo({ serverId: this.serverId, workspaceId })
      ) {
        workspaces.set(workspaceId, workspace);
      }
    }
    for (const workspace of workspaces.values()) this.applySetupStatus(workspace);
    this.workspaces = workspaces;
    this.projects = new Map(snapshot.projects);
    this.rebuildProjectIndex();
    const store = useSessionStore.getState();
    store.setWorkspaces(this.serverId, this.workspaces);
    store.setProjects(this.serverId, this.projects.values());
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

  private applySetupStatus(workspace: WorkspaceDescriptor): void {
    useWorkspaceSetupStore.getState().applySetupStatus({
      serverId: this.serverId,
      workspaceId: workspace.id,
      status: workspace.setupStatus ?? null,
    });
  }

  private setWorkspace(workspace: WorkspaceDescriptor): void {
    this.applySetupStatus(workspace);
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
