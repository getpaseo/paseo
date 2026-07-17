import { statSync, watch as watchPath } from "node:fs";
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
import {
  deriveProjectKind,
  reconcileWorkspacePlacement,
  type MutableWorkspacePlacement,
} from "./workspace-registry-model.js";
import { workspaceIdsForProjects } from "./workspace-directory.js";

const DEFAULT_RESCAN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DEBOUNCE_MS = 100;

export type ProjectUpdate =
  | { kind: "upsert"; project: PersistedProjectRecord }
  | { kind: "remove"; projectId: string };

interface ProjectRootWatcher {
  close(): void;
}

export interface ProjectRootWatch {
  (
    rootPath: string,
    options: { recursive: false },
    onChange: (event: string, filename: string | Buffer | null) => void,
    onError: (error: Error) => void,
  ): ProjectRootWatcher;
}

export interface ReconciliationTimer {
  unref?(): void;
}

export interface ReconciliationClock {
  setTimeout(callback: () => void | Promise<void>, delayMs: number): ReconciliationTimer;
  clearTimeout(timer: ReconciliationTimer): void;
  setInterval(callback: () => void | Promise<void>, delayMs: number): ReconciliationTimer;
  clearInterval(timer: ReconciliationTimer): void;
}

const systemClock: ReconciliationClock = {
  setTimeout: (callback, delayMs) => setTimeout(() => void callback(), delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => setInterval(() => void callback(), delayMs),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

const watchProjectRoot: ProjectRootWatch = (rootPath, options, onChange, onError) => {
  const watcher = watchPath(rootPath, options, onChange);
  watcher.on("error", onError);
  return watcher;
};

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
      fields: Partial<MutableWorkspacePlacement>;
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
  onProjectUpdate?: (update: ProjectUpdate) => void;
  onWorkspacesChanged?: (workspaceIds: string[]) => Promise<void>;
  watchProjectRoot?: ProjectRootWatch;
  clock?: ReconciliationClock;
  rescanIntervalMs?: number;
  debounceMs?: number;
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

type DirectoryState = "directory" | "missing" | "unreadable";

export class WorkspaceReconciliationService {
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly logger: pino.Logger;
  private readonly onChanges: ((changes: ReconciliationChange[]) => void) | null;
  private readonly workspaceGitService: Pick<WorkspaceGitService, "getCheckout"> | null;
  private readonly onProjectUpdate: ((update: ProjectUpdate) => void) | null;
  private readonly onWorkspacesChanged: ((workspaceIds: string[]) => Promise<void>) | null;
  private readonly watchProjectRoot: ProjectRootWatch;
  private readonly clock: ReconciliationClock;
  private readonly rescanIntervalMs: number;
  private readonly debounceMs: number;
  private readonly watchers: Array<{ rootPath: string; watcher: ProjectRootWatcher }> = [];
  private unsubscribeRegistry: (() => void) | null = null;
  private rescanTimer: ReconciliationTimer | null = null;
  private debounceTimer: ReconciliationTimer | null = null;
  private disposed = false;
  private started = false;
  private reconciling = false;
  private reconcileQueuedMode: "metadata" | "full" | null = null;

  constructor(options: WorkspaceReconciliationServiceOptions) {
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.logger = options.logger.child({ module: "workspace-reconciliation" });
    this.onChanges = options.onChanges ?? null;
    this.workspaceGitService = options.workspaceGitService ?? null;
    this.onProjectUpdate = options.onProjectUpdate ?? null;
    this.onWorkspacesChanged = options.onWorkspacesChanged ?? null;
    this.watchProjectRoot = options.watchProjectRoot ?? watchProjectRoot;
    this.clock = options.clock ?? systemClock;
    this.rescanIntervalMs = options.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeRegistry =
      this.projectRegistry.subscribeToMutations?.(async (mutation) => {
        try {
          // Project creation does not resolve until its root watch is installed,
          // closing the git-init race for newly added empty projects.
          await this.syncProjectRootWatches();
          if (this.disposed) return;
          if (mutation.kind === "upsert" && mutation.project && !mutation.project.archivedAt) {
            this.onProjectUpdate?.({ kind: "upsert", project: mutation.project });
          } else {
            this.onProjectUpdate?.({ kind: "remove", projectId: mutation.projectId });
          }
        } catch (error) {
          this.logger.warn({ err: error }, "Project reconciliation mutation handling failed");
        }
      }) ?? null;
    await this.syncProjectRootWatches();
    this.rescanTimer = this.clock.setInterval(
      () => this.reconcileObservedGitMetadata("full"),
      this.rescanIntervalMs,
    );
    this.rescanTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = null;
    if (this.rescanTimer) this.clock.clearInterval(this.rescanTimer);
    if (this.debounceTimer) this.clock.clearTimeout(this.debounceTimer);
    for (const { watcher } of this.watchers) watcher.close();
    this.watchers.length = 0;
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
      if (workspace.archivedAt || this.inspectDirectory(workspace.cwd) !== "directory") continue;
      const siblings = workspacesByProject.get(workspace.projectId) ?? [];
      siblings.push(workspace);
      workspacesByProject.set(workspace.projectId, siblings);
    }
    await this.reconcileGitMetadataForProjects(
      projects.filter(
        (project) => !project.archivedAt && this.inspectDirectory(project.rootPath) === "directory",
      ),
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
    const workspaceDirectoryStates = activeWorkspaces.map((workspace) => ({
      workspace,
      state: this.inspectDirectory(workspace.cwd),
    }));

    const workspacesByProject = new Map<string, PersistedWorkspaceRecord[]>();
    for (const { workspace, state } of workspaceDirectoryStates) {
      if (state !== "directory") continue;
      const list = workspacesByProject.get(workspace.projectId) ?? [];
      list.push(workspace);
      workspacesByProject.set(workspace.projectId, list);
    }

    // 1. Archive workspaces whose directories no longer exist
    const missingWorkspaces = workspaceDirectoryStates
      .filter(({ state }) => state === "missing")
      .map(({ workspace }) => workspace);
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
      activeProjects.filter((project) => this.inspectDirectory(project.rootPath) === "directory"),
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
    const workspaceCheckouts = await Promise.all(
      siblings.map(async (workspace) => ({
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
        const timestamp = new Date().toISOString();
        const update = reconcileWorkspacePlacement({
          workspace,
          checkout: wsGit,
          updatedAt: timestamp,
        });
        if (!update) return;

        await this.workspaceRegistry.upsert(update.workspace);
        changes.push({
          kind: "workspace_updated",
          workspaceId: workspace.workspaceId,
          directory: workspace.cwd,
          fields: update.fields,
        });
      }),
    );
  }

  private async syncProjectRootWatches(): Promise<void> {
    if (this.disposed) return;
    const projects = await this.projectRegistry.list();
    if (this.disposed) return;
    const activeProjects = projects.filter((project) => !project.archivedAt);

    for (let index = this.watchers.length - 1; index >= 0; index -= 1) {
      const target = this.watchers[index]!;
      const stillActive = activeProjects.some((project) =>
        areEquivalentPaths(project.rootPath, target.rootPath),
      );
      if (stillActive) continue;
      target.watcher.close();
      this.watchers.splice(index, 1);
    }

    for (const project of activeProjects) {
      const alreadyWatching = this.watchers.some((target) =>
        areEquivalentPaths(target.rootPath, project.rootPath),
      );
      if (alreadyWatching) continue;
      try {
        let watcher: ProjectRootWatcher;
        watcher = this.watchProjectRoot(
          project.rootPath,
          { recursive: false },
          (_event, filename) => {
            if (filename === null || filename.toString() === ".git") {
              this.scheduleObservedReconciliation();
            }
          },
          (error) => {
            watcher.close();
            const index = this.watchers.findIndex((target) => target.watcher === watcher);
            if (index >= 0) this.watchers.splice(index, 1);
            this.logger.warn(
              { err: error, rootPath: project.rootPath },
              "Project root watch failed",
            );
          },
        );
        this.watchers.push({ rootPath: project.rootPath, watcher });
      } catch (error) {
        // The periodic reconciliation is the convergence path for roots that
        // are temporarily missing or unwatchable.
        this.logger.debug(
          { err: error, rootPath: project.rootPath },
          "Project root is not watchable yet",
        );
      }
    }
  }

  private scheduleObservedReconciliation(): void {
    if (this.disposed || this.debounceTimer) return;
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = null;
      return this.reconcileObservedGitMetadata();
    }, this.debounceMs);
  }

  private async reconcileObservedGitMetadata(
    mode: "metadata" | "full" = "metadata",
  ): Promise<void> {
    if (this.disposed) return;
    if (this.reconciling) {
      if (mode === "full" || this.reconcileQueuedMode === null) {
        this.reconcileQueuedMode = mode;
      }
      return;
    }
    this.reconciling = true;
    try {
      await this.syncProjectRootWatches();
      const result = mode === "full" ? await this.runOnce() : await this.reconcileGitMetadata();
      const workspaceIds = new Set<string>();
      const projectIds = new Set<string>();
      for (const change of result.changesApplied) {
        if (change.kind === "workspace_updated" || change.kind === "workspace_archived") {
          workspaceIds.add(change.workspaceId);
        }
        if (change.kind === "project_updated") projectIds.add(change.projectId);
      }
      if (projectIds.size > 0) {
        const workspaces = await this.workspaceRegistry.list();
        for (const workspaceId of workspaceIdsForProjects(workspaces, projectIds)) {
          workspaceIds.add(workspaceId);
        }
      }
      if (!this.disposed && workspaceIds.size > 0) {
        await this.onWorkspacesChanged?.(Array.from(workspaceIds));
      }
    } catch (error) {
      if (!this.disposed) {
        this.logger.warn({ err: error }, "Workspace reconciliation failed");
      }
    } finally {
      this.reconciling = false;
      if (this.reconcileQueuedMode) {
        const queuedMode = this.reconcileQueuedMode;
        this.reconcileQueuedMode = null;
        void this.reconcileObservedGitMetadata(queuedMode);
      }
    }
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

  private inspectDirectory(targetPath: string): DirectoryState {
    try {
      return statSync(targetPath).isDirectory() ? "directory" : "missing";
    } catch (error) {
      if (isMissingPathError(error)) return "missing";
      this.logger.warn(
        { err: error, targetPath },
        "Skipped workspace reconciliation after directory inspection failed",
      );
      return "unreadable";
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}
