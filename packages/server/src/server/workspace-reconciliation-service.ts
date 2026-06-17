import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type pino from "pino";
import type {
  ProjectRegistry,
  WorkspaceRegistry,
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

function deriveWorkspaceKindFromMetadata(metadata: {
  projectKind: "git" | "directory";
  isWorktree: boolean;
}): PersistedWorkspaceRecord["kind"] {
  if (metadata.projectKind !== "git") return "directory";
  if (metadata.isWorktree) return "worktree";
  return "local_checkout";
}

function chooseCanonicalProject(projects: PersistedProjectRecord[]): PersistedProjectRecord {
  return [...projects].sort((left, right) => {
    const leftRemote = left.projectId.startsWith("remote:");
    const rightRemote = right.projectId.startsWith("remote:");
    if (leftRemote !== rightRemote) {
      return leftRemote ? -1 : 1;
    }
    const createdAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    if (createdAt !== 0) {
      return createdAt;
    }
    return left.projectId.localeCompare(right.projectId);
  })[0]!;
}

export type ReconciliationChange =
  | { kind: "workspace_archived"; workspaceId: string; directory: string; reason: string }
  | { kind: "project_archived"; projectId: string; directory: string; reason: string }
  | {
      kind: "project_updated";
      projectId: string;
      directory: string;
      fields: Partial<
        Pick<PersistedProjectRecord, "kind" | "displayName" | "rootPath" | "customName">
      >;
    }
  | {
      kind: "workspace_updated";
      workspaceId: string;
      directory: string;
      fields: Partial<Pick<PersistedWorkspaceRecord, "projectId" | "branch" | "kind">>;
    };

export interface ReconciliationResult {
  changesApplied: ReconciliationChange[];
  durationMs: number;
}

export interface WorkspaceReconciliationServiceOptions {
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  logger: pino.Logger;
  intervalMs?: number;
  onChanges?: (changes: ReconciliationChange[]) => void;
  workspaceGitService?: Pick<WorkspaceGitService, "getWorkspaceGitMetadata">;
}

export class WorkspaceReconciliationService {
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly logger: pino.Logger;
  private readonly intervalMs: number;
  private readonly onChanges: ((changes: ReconciliationChange[]) => void) | null;
  private readonly workspaceGitService: Pick<WorkspaceGitService, "getWorkspaceGitMetadata"> | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: WorkspaceReconciliationServiceOptions) {
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.logger = options.logger.child({ module: "workspace-reconciliation" });
    this.intervalMs = options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.onChanges = options.onChanges ?? null;
    this.workspaceGitService = options.workspaceGitService ?? null;
  }

  start(): void {
    if (this.timer) return;
    this.logger.info({ intervalMs: this.intervalMs }, "Starting workspace reconciliation service");
    this.timer = setInterval(() => void this.runSafe(), this.intervalMs);
    // Run once immediately on start
    void this.runSafe();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<ReconciliationResult> {
    return this.reconcile();
  }

  private async runSafe(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reconcile();
    } catch (error) {
      this.logger.error({ err: error }, "Reconciliation pass failed");
    } finally {
      this.running = false;
    }
  }

  private async reconcile(): Promise<ReconciliationResult> {
    const start = Date.now();
    const changes: ReconciliationChange[] = [];

    const allProjects = await this.projectRegistry.list();
    const allWorkspaces = await this.workspaceRegistry.list();

    const activeProjects = allProjects.filter((p) => !p.archivedAt);
    const activeWorkspaces = allWorkspaces.filter((w) => !w.archivedAt);

    const workspacesByProject = new Map<string, PersistedWorkspaceRecord[]>();
    for (const workspace of activeWorkspaces) {
      const list = workspacesByProject.get(workspace.projectId) ?? [];
      list.push(workspace);
      workspacesByProject.set(workspace.projectId, list);
    }

    // 1. Archive workspaces whose directories no longer exist
    const missingWorkspaces = activeWorkspaces.filter((workspace) => !existsSync(workspace.cwd));
    await Promise.all(
      missingWorkspaces.map(async (workspace) => {
        const timestamp = new Date().toISOString();
        await this.workspaceRegistry.archive(workspace.workspaceId, timestamp);
        changes.push({
          kind: "workspace_archived",
          workspaceId: workspace.workspaceId,
          directory: workspace.cwd,
          reason: "directory_missing",
        });

        // Update the in-memory list for the project orphan check below
        const siblings = workspacesByProject.get(workspace.projectId);
        if (siblings) {
          const updated = siblings.filter((w) => w.workspaceId !== workspace.workspaceId);
          workspacesByProject.set(workspace.projectId, updated);
        }
      }),
    );

    // 2. Merge duplicate active project records that point at the same repo root.
    await this.mergeDuplicateProjectsByRoot(activeProjects, workspacesByProject, changes);

    // 3. Reconcile git metadata for active projects whose directories still exist.
    //    A project with zero active workspaces is a first-class empty project — it
    //    persists until explicitly removed and still reconciles its own metadata.
    //    Skip projects archived earlier in this pass (e.g. merged duplicates) so we
    //    don't resurrect them by upserting a stale, non-archived copy.
    const archivedProjectIds = new Set(
      changes
        .filter((change) => change.kind === "project_archived")
        .map((change) => change.projectId),
    );
    const projectsToReconcile = activeProjects.filter((project) => {
      if (project.archivedAt) return false;
      if (archivedProjectIds.has(project.projectId)) return false;
      if (!existsSync(project.rootPath)) return false;
      return true;
    });
    await Promise.all(
      projectsToReconcile.map((project) =>
        this.reconcileProject(project, workspacesByProject.get(project.projectId) ?? [], changes),
      ),
    );

    if (changes.length > 0 && this.onChanges) {
      this.onChanges(changes);
    }

    const result = { changesApplied: changes, durationMs: Date.now() - start };
    if (changes.length > 0) {
      this.logger.info(
        {
          changeCount: changes.length,
          durationMs: result.durationMs,
          changes,
        },
        "Workspace reconciliation applied changes",
      );
    }

    return result;
  }

  private async mergeDuplicateProjectsByRoot(
    activeProjects: PersistedProjectRecord[],
    workspacesByProject: Map<string, PersistedWorkspaceRecord[]>,
    changes: ReconciliationChange[],
  ): Promise<void> {
    const projectsByRoot = new Map<string, PersistedProjectRecord[]>();
    for (const project of activeProjects) {
      if (project.kind !== "git") {
        continue;
      }
      const rootKey = resolve(project.rootPath);
      const group = projectsByRoot.get(rootKey) ?? [];
      group.push(project);
      projectsByRoot.set(rootKey, group);
    }

    for (const duplicates of projectsByRoot.values()) {
      if (duplicates.length < 2) {
        continue;
      }
      const canonical = chooseCanonicalProject(duplicates);
      const duplicateProjects = duplicates.filter(
        (project) => project.projectId !== canonical.projectId,
      );
      await this.mergeDuplicateProjectCustomName(canonical, duplicateProjects, changes);
      await Promise.all(
        duplicateProjects.flatMap((project) =>
          (workspacesByProject.get(project.projectId) ?? []).map(async (workspace) => {
            const timestamp = new Date().toISOString();
            const updatedWorkspace = {
              ...workspace,
              projectId: canonical.projectId,
              updatedAt: timestamp,
            };
            await this.workspaceRegistry.upsert(updatedWorkspace);
            changes.push({
              kind: "workspace_updated",
              workspaceId: workspace.workspaceId,
              directory: workspace.cwd,
              fields: {
                projectId: canonical.projectId,
              },
            });

            const canonicalSiblings = workspacesByProject.get(canonical.projectId) ?? [];
            canonicalSiblings.push(updatedWorkspace);
            workspacesByProject.set(canonical.projectId, canonicalSiblings);
          }),
        ),
      );

      for (const project of duplicateProjects) {
        workspacesByProject.set(project.projectId, []);
        const timestamp = new Date().toISOString();
        await this.projectRegistry.archive(project.projectId, timestamp);
        changes.push({
          kind: "project_archived",
          projectId: project.projectId,
          directory: project.rootPath,
          reason: "merged_duplicate",
        });
      }
    }
  }

  private async mergeDuplicateProjectCustomName(
    canonical: PersistedProjectRecord,
    duplicateProjects: PersistedProjectRecord[],
    changes: ReconciliationChange[],
  ): Promise<void> {
    if (canonical.customName) {
      return;
    }
    const customName = duplicateProjects.find((project) => project.customName)?.customName ?? null;
    if (!customName) {
      return;
    }

    const timestamp = new Date().toISOString();
    await this.projectRegistry.upsert({
      ...canonical,
      customName,
      updatedAt: timestamp,
    });
    canonical.customName = customName;
    changes.push({
      kind: "project_updated",
      projectId: canonical.projectId,
      directory: canonical.rootPath,
      fields: { customName },
    });
  }

  private async reconcileProject(
    project: PersistedProjectRecord,
    siblings: PersistedWorkspaceRecord[],
    changes: ReconciliationChange[],
  ): Promise<void> {
    const directoryName = project.rootPath.split(/[\\/]/).findLast(Boolean) ?? project.rootPath;
    const currentGit = await this.readWorkspaceGitMetadata(project.rootPath, directoryName);

    const projectUpdates: Partial<
      Pick<PersistedProjectRecord, "kind" | "displayName" | "rootPath">
    > = {};

    const mappedKind = currentGit.projectKind === "git" ? "git" : "non_git";

    if (project.kind !== mappedKind) {
      projectUpdates.kind = mappedKind;
      projectUpdates.displayName = currentGit.projectDisplayName;
    }

    if (
      project.kind === "git" &&
      currentGit.projectKind === "git" &&
      project.displayName !== currentGit.projectDisplayName
    ) {
      projectUpdates.displayName = currentGit.projectDisplayName;
    }

    if (Object.keys(projectUpdates).length > 0) {
      const timestamp = new Date().toISOString();
      await this.projectRegistry.upsert({
        ...project,
        ...projectUpdates,
        updatedAt: timestamp,
      });
      changes.push({
        kind: "project_updated",
        projectId: project.projectId,
        directory: project.rootPath,
        fields: projectUpdates,
      });
    }

    const existingSiblings = siblings.filter((workspace) => existsSync(workspace.cwd));
    await Promise.all(
      existingSiblings.map(async (workspace) => {
        const wsDirName = workspace.cwd.split(/[\\/]/).findLast(Boolean) ?? workspace.cwd;
        const wsGit = await this.readWorkspaceGitMetadata(workspace.cwd, wsDirName);

        const expectedKind = deriveWorkspaceKindFromMetadata(wsGit);

        const workspaceUpdates: Partial<Pick<PersistedWorkspaceRecord, "branch" | "kind">> = {};

        if (wsGit.projectKind === "git" && workspace.branch !== wsGit.currentBranch) {
          workspaceUpdates.branch = wsGit.currentBranch;
        }

        if (workspace.kind !== expectedKind) {
          workspaceUpdates.kind = expectedKind;
        }

        if (Object.keys(workspaceUpdates).length === 0) {
          return;
        }

        const timestamp = new Date().toISOString();
        await this.workspaceRegistry.upsert({
          ...workspace,
          ...workspaceUpdates,
          updatedAt: timestamp,
        });
        changes.push({
          kind: "workspace_updated",
          workspaceId: workspace.workspaceId,
          directory: workspace.cwd,
          fields: workspaceUpdates,
        });
      }),
    );
  }

  private async readWorkspaceGitMetadata(cwd: string, directoryName: string) {
    if (!this.workspaceGitService) {
      return {
        projectKind: "directory" as const,
        projectDisplayName: directoryName,
        workspaceDisplayName: directoryName,
        gitRemote: null,
        isWorktree: false,
        projectSlug: "untitled",
        repoRoot: null,
        currentBranch: null,
        remoteUrl: null,
      };
    }
    return this.workspaceGitService.getWorkspaceGitMetadata(cwd, { directoryName });
  }
}
