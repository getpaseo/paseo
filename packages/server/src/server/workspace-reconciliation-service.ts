import { stat } from "node:fs/promises";

import type { ProjectPlacementPayload } from "./messages.js";
import type { AgentSnapshotStore } from "./agent/agent-snapshot-store.js";
import {
  detectStaleWorkspaces,
  deriveProjectKind,
  deriveProjectRootPath,
  deriveWorkspaceDisplayName,
  deriveWorkspaceKind,
  normalizeWorkspaceId as normalizePersistedWorkspaceId,
} from "./workspace-registry-model.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "./workspace-registry.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";

type Awaitable<T> = T | Promise<T>;

export type WorkspaceReconciliationServiceOptions = {
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  agentStorage: Pick<AgentSnapshotStore, "list">;
  buildProjectPlacement: (cwd: string) => Promise<ProjectPlacementPayload>;
  syncWorkspaceGitWatchTarget?: (
    cwd: string,
    options: { isGit: boolean },
  ) => Awaitable<void>;
  removeWorkspaceGitWatchTarget?: (cwd: string) => Awaitable<void>;
  checkDirectoryExists?: (cwd: string) => Promise<boolean>;
  now?: () => string;
};

export type ReconcileWorkspaceRecordResult = {
  workspace: PersistedWorkspaceRecord;
  changed: boolean;
};

export class WorkspaceReconciliationService {
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly agentStorage: Pick<AgentSnapshotStore, "list">;
  private readonly buildProjectPlacement: (cwd: string) => Promise<ProjectPlacementPayload>;
  private readonly syncWorkspaceGitWatchTarget: (
    cwd: string,
    options: { isGit: boolean },
  ) => Promise<void>;
  private readonly removeWorkspaceGitWatchTarget: (cwd: string) => Promise<void>;
  private readonly checkDirectoryExists: (cwd: string) => Promise<boolean>;
  private readonly now: () => string;

  constructor(options: WorkspaceReconciliationServiceOptions) {
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.agentStorage = options.agentStorage;
    this.buildProjectPlacement = options.buildProjectPlacement;
    this.syncWorkspaceGitWatchTarget = async (cwd, syncOptions) => {
      await options.syncWorkspaceGitWatchTarget?.(cwd, syncOptions);
    };
    this.removeWorkspaceGitWatchTarget = async (cwd) => {
      await options.removeWorkspaceGitWatchTarget?.(cwd);
    };
    this.checkDirectoryExists =
      options.checkDirectoryExists ??
      (async (cwd) => {
        try {
          await stat(cwd);
          return true;
        } catch {
          return false;
        }
      });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async reconcileWorkspaceRecord(workspaceId: string): Promise<ReconcileWorkspaceRecordResult> {
    const normalizedWorkspaceId = normalizePersistedWorkspaceId(workspaceId);
    const existingWorkspace = await this.workspaceRegistry.get(normalizedWorkspaceId);
    const placement = await this.buildProjectPlacement(normalizedWorkspaceId);
    await this.syncWorkspaceGitWatchTarget(normalizedWorkspaceId, {
      isGit: placement.checkout.isGit,
    });

    const now = this.now();
    const nextWorkspaceCreatedAt = existingWorkspace?.createdAt ?? now;
    const currentProjectRecord = await this.projectRegistry.get(placement.projectKey);
    const nextProjectRecord = this.buildPersistedProjectRecord({
      workspaceId: normalizedWorkspaceId,
      placement,
      createdAt: currentProjectRecord?.createdAt ?? nextWorkspaceCreatedAt,
      updatedAt: now,
    });
    const nextWorkspaceRecord = this.buildPersistedWorkspaceRecord({
      workspaceId: normalizedWorkspaceId,
      placement,
      createdAt: nextWorkspaceCreatedAt,
      updatedAt: now,
    });

    const needsWorkspaceUpdate =
      !existingWorkspace ||
      existingWorkspace.archivedAt ||
      existingWorkspace.projectId !== nextWorkspaceRecord.projectId ||
      existingWorkspace.kind !== nextWorkspaceRecord.kind ||
      existingWorkspace.displayName !== nextWorkspaceRecord.displayName;
    const needsProjectUpdate =
      !currentProjectRecord ||
      currentProjectRecord.archivedAt ||
      currentProjectRecord.rootPath !== nextProjectRecord.rootPath ||
      currentProjectRecord.kind !== nextProjectRecord.kind ||
      currentProjectRecord.displayName !== nextProjectRecord.displayName;

    if (!needsWorkspaceUpdate && !needsProjectUpdate) {
      return {
        workspace: existingWorkspace!,
        changed: false,
      };
    }

    await this.projectRegistry.upsert(nextProjectRecord);
    await this.workspaceRegistry.upsert(nextWorkspaceRecord);

    if (
      existingWorkspace &&
      !existingWorkspace.archivedAt &&
      existingWorkspace.projectId !== nextWorkspaceRecord.projectId
    ) {
      await this.archiveProjectRecordIfEmpty(existingWorkspace.projectId, now);
    }

    return {
      workspace: nextWorkspaceRecord,
      changed: true,
    };
  }

  async reconcileActiveWorkspaceRecords(): Promise<Set<string>> {
    const changedWorkspaceIds = new Set<string>();
    const activeWorkspaces = (await this.workspaceRegistry.list()).filter(
      (workspace) => !workspace.archivedAt,
    );
    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces,
      agentRecords: (await this.agentStorage.list()).map((agent) => ({
        cwd: agent.cwd,
        archivedAt: agent.archivedAt ?? null,
      })),
      checkDirectoryExists: this.checkDirectoryExists,
    });

    for (const workspaceId of staleWorkspaceIds) {
      await this.archiveWorkspaceRecord(workspaceId);
      changedWorkspaceIds.add(workspaceId);
    }

    for (const workspace of activeWorkspaces) {
      if (staleWorkspaceIds.has(workspace.workspaceId)) {
        continue;
      }

      const result = await this.reconcileWorkspaceRecord(workspace.workspaceId);
      if (result.changed) {
        changedWorkspaceIds.add(result.workspace.workspaceId);
      }
    }

    return changedWorkspaceIds;
  }

  async registerPendingWorktreeWorkspace(options: {
    repoRoot: string;
    worktreePath: string;
    branchName: string;
  }): Promise<PersistedWorkspaceRecord> {
    const workspaceId = normalizePersistedWorkspaceId(options.worktreePath);
    const basePlacement = await this.buildProjectPlacement(options.repoRoot);
    const placement: ProjectPlacementPayload = {
      ...basePlacement,
      checkout: {
        cwd: workspaceId,
        isGit: true,
        currentBranch: options.branchName,
        remoteUrl: basePlacement.checkout.remoteUrl,
        isPaseoOwnedWorktree: true,
        mainRepoRoot: options.repoRoot,
      },
    };
    const now = this.now();
    const existingWorkspace = await this.workspaceRegistry.get(workspaceId);
    const existingProject = await this.projectRegistry.get(placement.projectKey);
    const nextProjectRecord = this.buildPersistedProjectRecord({
      workspaceId,
      placement,
      createdAt: existingProject?.createdAt ?? now,
      updatedAt: now,
    });
    const nextWorkspaceRecord = this.buildPersistedWorkspaceRecord({
      workspaceId,
      placement,
      createdAt: existingWorkspace?.createdAt ?? now,
      updatedAt: now,
    });

    await this.projectRegistry.upsert(nextProjectRecord);
    await this.workspaceRegistry.upsert(nextWorkspaceRecord);
    await this.syncWorkspaceGitWatchTarget(workspaceId, {
      isGit: placement.checkout.isGit,
    });

    if (
      existingWorkspace &&
      !existingWorkspace.archivedAt &&
      existingWorkspace.projectId !== nextWorkspaceRecord.projectId
    ) {
      await this.archiveProjectRecordIfEmpty(existingWorkspace.projectId, now);
    }

    return nextWorkspaceRecord;
  }

  async archiveWorkspaceRecord(workspaceId: string, archivedAt?: string): Promise<void> {
    const normalizedWorkspaceId = normalizePersistedWorkspaceId(workspaceId);
    const existingWorkspace = await this.workspaceRegistry.get(normalizedWorkspaceId);
    if (!existingWorkspace || existingWorkspace.archivedAt) {
      await this.removeWorkspaceGitWatchTarget(normalizedWorkspaceId);
      return;
    }

    const nextArchivedAt = archivedAt ?? this.now();
    await this.workspaceRegistry.archive(normalizedWorkspaceId, nextArchivedAt);
    await this.removeWorkspaceGitWatchTarget(normalizedWorkspaceId);

    const siblingWorkspaces = (await this.workspaceRegistry.list()).filter(
      (workspace) => workspace.projectId === existingWorkspace.projectId && !workspace.archivedAt,
    );
    if (siblingWorkspaces.length === 0) {
      await this.projectRegistry.archive(existingWorkspace.projectId, nextArchivedAt);
    }
  }

  private buildPersistedProjectRecord(input: {
    workspaceId: string;
    placement: ProjectPlacementPayload;
    createdAt: string;
    updatedAt: string;
  }): PersistedProjectRecord {
    return createPersistedProjectRecord({
      projectId: input.placement.projectKey,
      rootPath: deriveProjectRootPath({
        cwd: input.workspaceId,
        checkout: input.placement.checkout,
      }),
      kind: deriveProjectKind(input.placement.checkout),
      displayName: input.placement.projectName,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      archivedAt: null,
    });
  }

  private buildPersistedWorkspaceRecord(input: {
    workspaceId: string;
    placement: ProjectPlacementPayload;
    createdAt: string;
    updatedAt: string;
  }): PersistedWorkspaceRecord {
    return createPersistedWorkspaceRecord({
      workspaceId: input.workspaceId,
      projectId: input.placement.projectKey,
      cwd: input.workspaceId,
      kind: deriveWorkspaceKind(input.placement.checkout),
      displayName: deriveWorkspaceDisplayName({
        cwd: input.workspaceId,
        checkout: input.placement.checkout,
      }),
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      archivedAt: null,
    });
  }

  private async archiveProjectRecordIfEmpty(projectId: string, archivedAt: string): Promise<void> {
    const siblingWorkspaces = (await this.workspaceRegistry.list()).filter(
      (workspace) => workspace.projectId === projectId && !workspace.archivedAt,
    );
    if (siblingWorkspaces.length === 0) {
      await this.projectRegistry.archive(projectId, archivedAt);
    }
  }
}
