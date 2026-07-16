import { existsSync } from "node:fs";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import type pino from "pino";
import type {
  ProjectRegistry,
  WorkspaceRegistry,
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { areEquivalentPaths } from "../utils/path.js";
import { deriveProjectKind, deriveWorkspaceKind } from "./workspace-registry-model.js";

export type ReconciliationChange =
  | { kind: "workspace_archived"; workspaceId: string; directory: string; reason: string }
  | {
      kind: "project_updated";
      projectId: string;
      directory: string;
      fields: Partial<Pick<PersistedProjectRecord, "kind">>;
    }
  | {
      kind: "workspace_updated";
      workspaceId: string;
      directory: string;
      fields: Partial<Pick<PersistedWorkspaceRecord, "branch" | "kind">>;
    };

export interface ReconciliationResult {
  changesApplied: ReconciliationChange[];
  durationMs: number;
}

export interface WorkspaceReconciliationServiceOptions {
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  logger: pino.Logger;
  onChanges?: (changes: ReconciliationChange[]) => void;
  workspaceGitService?: Pick<WorkspaceGitService, "getCheckout">;
}

interface ProjectReconciliationInput {
  project: PersistedProjectRecord;
  siblings: PersistedWorkspaceRecord[];
  currentGit: ProjectCheckoutLitePayload;
  readCheckout: (cwd: string) => Promise<ProjectCheckoutLitePayload>;
  changes: ReconciliationChange[];
}

interface CachedCheckoutRead {
  cwd: string;
  checkout: Promise<ProjectCheckoutLitePayload>;
}

export class WorkspaceReconciliationService {
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly logger: pino.Logger;
  private readonly onChanges: ((changes: ReconciliationChange[]) => void) | null;
  private readonly workspaceGitService: Pick<WorkspaceGitService, "getCheckout"> | null;

  constructor(options: WorkspaceReconciliationServiceOptions) {
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.logger = options.logger.child({ module: "workspace-reconciliation" });
    this.onChanges = options.onChanges ?? null;
    this.workspaceGitService = options.workspaceGitService ?? null;
  }

  /** Reconciles mutable Git facts only; never archives missing records. */
  async reconcileGitMetadata(): Promise<ReconciliationResult> {
    const start = Date.now();
    const changes: ReconciliationChange[] = [];
    const [projects, workspaces] = await Promise.all([
      this.projectRegistry.list(),
      this.workspaceRegistry.list(),
    ]);
    const workspacesByProject = new Map<string, PersistedWorkspaceRecord[]>();
    for (const workspace of workspaces) {
      if (workspace.archivedAt) continue;
      const siblings = workspacesByProject.get(workspace.projectId) ?? [];
      siblings.push(workspace);
      workspacesByProject.set(workspace.projectId, siblings);
    }
    await this.reconcileGitMetadataForProjects(
      projects.filter((project) => !project.archivedAt && existsSync(project.rootPath)),
      workspacesByProject,
      changes,
    );
    if (changes.length > 0) this.onChanges?.(changes);
    return { changesApplied: changes, durationMs: Date.now() - start };
  }

  async runOnce(): Promise<ReconciliationResult> {
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

    // 2. Reconcile mutable git metadata without changing identity or membership.
    //    Projects persist until explicitly removed, even when they currently have
    //    zero active workspaces, so they still reconcile their own metadata.
    await this.reconcileGitMetadataForProjects(
      activeProjects.filter((project) => existsSync(project.rootPath)),
      workspacesByProject,
      changes,
    );

    if (changes.length > 0 && this.onChanges) {
      this.onChanges(changes);
    }

    const result = { changesApplied: changes, durationMs: Date.now() - start };
    if (changes.length > 0) {
      this.logger.info(
        { changeCount: changes.length, durationMs: result.durationMs, changes },
        "Workspace reconciliation applied changes",
      );
    }
    return result;
  }

  private async reconcileGitMetadataForProjects(
    projectsToReconcile: PersistedProjectRecord[],
    workspacesByProject: Map<string, PersistedWorkspaceRecord[]>,
    changes: ReconciliationChange[],
  ): Promise<void> {
    const checkoutReads: CachedCheckoutRead[] = [];
    const readCheckout = (cwd: string): Promise<ProjectCheckoutLitePayload> => {
      const existing = checkoutReads.find((read) => areEquivalentPaths(read.cwd, cwd));
      if (existing) return existing.checkout;
      const checkout = this.readCheckout(cwd);
      checkoutReads.push({ cwd, checkout });
      return checkout;
    };
    const roots: Array<{ rootPath: string; projects: PersistedProjectRecord[] }> = [];
    for (const project of projectsToReconcile) {
      const root = roots.find((candidate) =>
        areEquivalentPaths(candidate.rootPath, project.rootPath),
      );
      if (root) root.projects.push(project);
      else roots.push({ rootPath: project.rootPath, projects: [project] });
    }
    await Promise.all(
      roots.map(async ({ rootPath, projects }) => {
        try {
          const rootGit = await readCheckout(rootPath);
          await Promise.all(
            projects.map((project) =>
              this.reconcileProject({
                project,
                siblings: workspacesByProject.get(project.projectId) ?? [],
                currentGit: rootGit,
                readCheckout,
                changes,
              }),
            ),
          );
        } catch (error) {
          this.logger.warn(
            { err: error, rootPath },
            "Skipped workspace reconciliation after Git read failed",
          );
        }
      }),
    );
  }

  private async reconcileProject(input: ProjectReconciliationInput): Promise<void> {
    const { project, siblings, currentGit, readCheckout, changes } = input;
    const existingSiblings = siblings.filter((workspace) => existsSync(workspace.cwd));
    const workspaceCheckouts = await Promise.all(
      existingSiblings.map(async (workspace) => ({
        workspace,
        checkout: await readCheckout(workspace.cwd),
      })),
    );
    const projectUpdates: Partial<Pick<PersistedProjectRecord, "kind">> = {};
    const mappedKind = deriveProjectKind(currentGit);

    if (project.kind !== mappedKind) {
      projectUpdates.kind = mappedKind;
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

    await Promise.all(
      workspaceCheckouts.map(async ({ workspace, checkout: wsGit }) => {
        const expectedKind = deriveWorkspaceKind(wsGit);

        const workspaceUpdates: Partial<Pick<PersistedWorkspaceRecord, "branch" | "kind">> = {};

        if (workspace.branch !== (wsGit.isGit ? wsGit.currentBranch : null)) {
          workspaceUpdates.branch = wsGit.isGit ? wsGit.currentBranch : null;
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

  private async readCheckout(cwd: string): Promise<ProjectCheckoutLitePayload> {
    if (!this.workspaceGitService) {
      return {
        cwd,
        isGit: false as const,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false as const,
        mainRepoRoot: null,
      };
    }
    return this.workspaceGitService.getCheckout(cwd);
  }
}
