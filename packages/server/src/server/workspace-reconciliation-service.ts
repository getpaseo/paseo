import { existsSync } from "node:fs";
import type pino from "pino";
import type {
  ProjectRegistry,
  WorkspaceRegistry,
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

export type ReconciliationChange =
  | { kind: "workspace_archived"; workspaceId: string; directory: string; reason: string }
  | { kind: "project_archived"; projectId: string; directory: string; reason: string }
  | {
      kind: "project_updated";
      projectId: string;
      directory: string;
      fields: Partial<Pick<PersistedProjectRecord, "kind" | "displayName" | "rootPath">>;
    }
  | {
      kind: "workspace_updated";
      workspaceId: string;
      directory: string;
      fields: Partial<Pick<PersistedWorkspaceRecord, "displayName">>;
    };

export type ReconciliationResult = {
  changesApplied: ReconciliationChange[];
  durationMs: number;
};

export type WorkspaceReconciliationServiceOptions = {
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  logger: pino.Logger;
  intervalMs?: number;
  onChanges?: (changes: ReconciliationChange[]) => void;
  workspaceGitService?: Pick<WorkspaceGitService, "getWorkspaceGitMetadata">;
};

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
      const result = await this.reconcile();
      if (result.changesApplied.length > 0) {
        this.logger.info(
          { changeCount: result.changesApplied.length, durationMs: result.durationMs },
          "Reconciliation pass completed with changes",
        );
      }
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
    for (const workspace of activeWorkspaces) {
      if (!existsSync(workspace.cwd)) {
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
      }
    }

    // 2. Archive orphaned projects (all workspaces archived/removed)
    for (const project of activeProjects) {
      const siblings = workspacesByProject.get(project.projectId) ?? [];
      if (siblings.length === 0) {
        const timestamp = new Date().toISOString();
        await this.projectRegistry.archive(project.projectId, timestamp);
        changes.push({
          kind: "project_archived",
          projectId: project.projectId,
          directory: project.rootPath,
          reason: "no_active_workspaces",
        });
      }
    }

    // 3. Reconcile git metadata for active projects whose directories still exist
    for (const project of activeProjects) {
      if (project.archivedAt) continue;
      const siblings = workspacesByProject.get(project.projectId) ?? [];
      if (siblings.length === 0) continue;
      if (!existsSync(project.rootPath)) continue;

      const directoryName =
        project.rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? project.rootPath;
      const currentGit = await this.readWorkspaceGitMetadata(project.rootPath, directoryName);

      const projectUpdates: Partial<
        Pick<PersistedProjectRecord, "kind" | "displayName" | "rootPath">
      > = {};

      const mappedKind = currentGit.projectKind === "git" ? "git" : "non_git";

      // Detect kind change: directory → git
      if (project.kind !== mappedKind) {
        projectUpdates.kind = mappedKind;
        projectUpdates.displayName = currentGit.projectDisplayName;
      }

      // Detect display name change (e.g. remote renamed)
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

      // 4. Reconcile workspace display names (branch name changes)
      for (const workspace of siblings) {
        if (!existsSync(workspace.cwd)) continue;

        const wsDirName = workspace.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace.cwd;
        const wsGit = await this.readWorkspaceGitMetadata(workspace.cwd, wsDirName);

        if (wsGit.projectKind === "git" && workspace.displayName !== wsGit.workspaceDisplayName) {
          const timestamp = new Date().toISOString();
          await this.workspaceRegistry.upsert({
            ...workspace,
            displayName: wsGit.workspaceDisplayName,
            updatedAt: timestamp,
          });
          changes.push({
            kind: "workspace_updated",
            workspaceId: workspace.workspaceId,
            directory: workspace.cwd,
            fields: { displayName: wsGit.workspaceDisplayName },
          });
        }
      }
    }

    if (changes.length > 0 && this.onChanges) {
      this.onChanges(changes);
    }

    return { changesApplied: changes, durationMs: Date.now() - start };
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
