import { watch as watchPath } from "node:fs";
import { stat } from "node:fs/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";
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
import { deriveProjectKey } from "./project-key.js";

const DEFAULT_RESCAN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DEBOUNCE_MS = 100;
const INSPECTION_CONCURRENCY = 2;
const DEFAULT_INSPECTION_TIMEOUT_MS = 5000;

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
      fields: Partial<Pick<PersistedProjectRecord, "kind" | "projectKey">>;
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
  serverId?: string;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  logger: pino.Logger;
  onChanges?: (changes: ReconciliationChange[]) => void;
  workspaceGitService?: Pick<WorkspaceGitService, "getCheckout">;
  onProjectUpdate?: (update: ProjectUpdate) => void;
  onWorkspaceArchived?: (workspaceId: string) => void | Promise<void>;
  onWorkspacesChanged?: (workspaceIds: string[]) => Promise<void>;
  watchProjectRoot?: ProjectRootWatch;
  clock?: ReconciliationClock;
  rescanIntervalMs?: number;
  debounceMs?: number;
  inspectDirectory?: (targetPath: string) => Promise<DirectoryState>;
  inspectionTimeoutMs?: number;
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

export type DirectoryState = "directory" | "missing" | "unreadable";

export class WorkspaceReconciliationService {
  // Timed-out fs operations retain their slot until the OS returns. Never use
  // the deadline to admit more work into libuv's shared threadpool.
  private readonly timedOutPaths = new Set<string>();
  private inspectionSaturated = false;
  private readonly inspectionWaiters = new Set<() => void>();
  private readonly pendingInspections = new Map<string, Promise<DirectoryState>>();
  private readonly directoryInspection: (targetPath: string) => Promise<DirectoryState>;
  private readonly inspectionTimeoutMs: number;
  private readonly serverId: string | undefined;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly logger: pino.Logger;
  private readonly onChanges: ((changes: ReconciliationChange[]) => void) | null;
  private readonly workspaceGitService: Pick<WorkspaceGitService, "getCheckout"> | null;
  private readonly onProjectUpdate: ((update: ProjectUpdate) => void) | null;
  private readonly onWorkspaceArchived: ((workspaceId: string) => void | Promise<void>) | null;
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
    this.directoryInspection =
      options.inspectDirectory ??
      (async (targetPath) => ((await stat(targetPath)).isDirectory() ? "directory" : "missing"));
    this.inspectionTimeoutMs = options.inspectionTimeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS;
    this.serverId = options.serverId;
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.logger = options.logger.child({ module: "workspace-reconciliation" });
    this.onChanges = options.onChanges ?? null;
    this.workspaceGitService = options.workspaceGitService ?? null;
    this.onProjectUpdate = options.onProjectUpdate ?? null;
    this.onWorkspaceArchived = options.onWorkspaceArchived ?? null;
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
    this.wakeInspectionWaiters();
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
    const workspaceStates = await mapBounded(
      workspaces.filter((w) => !w.archivedAt),
      async (workspace) => ({ workspace, state: await this.inspectDirectory(workspace.cwd) }),
    );
    for (const { workspace, state } of workspaceStates) {
      if (state !== "directory") continue;
      if ((await this.workspaceRegistry.get(workspace.workspaceId))?.archivedAt !== null) continue;
      const siblings = workspacesByProject.get(workspace.projectId) ?? [];
      siblings.push(workspace);
      workspacesByProject.set(workspace.projectId, siblings);
    }
    const projectStates = await mapBounded(
      projects.filter((p) => !p.archivedAt),
      async (project) => ({ project, state: await this.inspectDirectory(project.rootPath) }),
    );
    await this.reconcileGitMetadataForProjects(
      projectStates.filter(({ state }) => state === "directory").map(({ project }) => project),
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
    const activeProjectsById = new Map(
      activeProjects.map((project) => [project.projectId, project]),
    );
    const activeWorkspaces = allWorkspaces.filter((w) => !w.archivedAt);
    const workspaceDirectoryStates = await mapBounded(activeWorkspaces, async (workspace) => ({
      workspace,
      state: await this.inspectDirectory(workspace.cwd),
    }));
    // Read project roots after workspaces: losing a volume can withhold an
    // archive, never turn a workspace's absence into proof of deletion.
    const projectStates = await mapBounded(activeProjects, async (project) => ({
      project,
      state: await this.inspectDirectory(project.rootPath),
    }));
    const reachableProjectIds = new Set(
      projectStates
        .filter(({ state }) => state === "directory")
        .map(({ project }) => project.projectId),
    );

    const workspacesByProject = new Map<string, PersistedWorkspaceRecord[]>();
    for (const { workspace, state } of workspaceDirectoryStates) {
      if (state !== "directory") continue;
      if ((await this.workspaceRegistry.get(workspace.workspaceId))?.archivedAt !== null) continue;
      const list = workspacesByProject.get(workspace.projectId) ?? [];
      list.push(workspace);
      workspacesByProject.set(workspace.projectId, list);
    }

    // 1. Archive workspaces whose directories no longer exist, but only when the
    //    project they belong to is still reachable. A missing project root means the
    //    whole location is unavailable - an unmounted volume, an offline share, a disk
    //    that has not appeared yet - and absence there proves nothing about the
    //    workspace. Projects already persist through that; their workspaces do too.
    const missingWorkspaces = workspaceDirectoryStates
      .filter(
        ({ workspace, state }) =>
          state === "missing" && reachableProjectIds.has(workspace.projectId),
      )
      .map(({ workspace }) => workspace);
    await mapBounded(missingWorkspaces, async (workspace) => {
      const current = await this.workspaceRegistry.get(workspace.workspaceId);
      const project = await this.projectRegistry.get(workspace.projectId);
      if (
        !current ||
        current.archivedAt ||
        current.cwd !== workspace.cwd ||
        current.projectId !== workspace.projectId ||
        !project ||
        project.archivedAt ||
        project.rootPath !== activeProjectsById.get(project.projectId)?.rootPath
      )
        return;
      const timestamp = new Date().toISOString();
      if (!(await this.workspaceRegistry.archive(workspace.workspaceId, timestamp))) return;
      await this.onWorkspaceArchived?.(workspace.workspaceId);
      changes.push({
        kind: "workspace_archived",
        workspaceId: workspace.workspaceId,
        directory: workspace.cwd,
        reason: "directory_missing",
      });
    });

    // 2. Reconcile mutable git metadata without changing identity or membership.
    //    Projects persist until explicitly removed, even when they currently have
    //    zero active workspaces, so they still reconcile their own metadata.
    await this.reconcileGitMetadataForProjects(
      activeProjects.filter((project) => reachableProjectIds.has(project.projectId)),
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

  /** Runs the boot-time convergence path and publishes every affected workspace. */
  async reconcileNow(): Promise<void> {
    await this.reconcileObservedGitMetadata("full");
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
    const { siblings, currentGit, readCheckout, changes } = input;
    const workspaceCheckouts = await Promise.all(
      siblings.map(async (workspace) => {
        const current = await this.workspaceRegistry.get(workspace.workspaceId);
        if (!current || current.cwd !== workspace.cwd || current.projectId !== workspace.projectId)
          return null;
        return { workspace: current, checkout: await readCheckout(current.cwd) };
      }),
    );
    const project = await this.projectRegistry.get(input.project.projectId);
    if (!project || project.archivedAt || project.rootPath !== input.project.rootPath) return;
    const projectUpdates: Partial<Pick<PersistedProjectRecord, "kind" | "projectKey">> = {};
    const mappedKind = deriveProjectKind(currentGit);
    const projectKey = deriveProjectKey({
      rootPath: project.rootPath,
      remoteUrl: currentGit.remoteUrl,
      worktreeRoot: currentGit.worktreeRoot,
      mainRepoRoot: currentGit.mainRepoRoot,
      serverId: this.serverId,
    });

    if (project.kind !== mappedKind) {
      projectUpdates.kind = mappedKind;
    }
    if (project.projectKey !== projectKey) {
      projectUpdates.projectKey = projectKey;
    }

    if (Object.keys(projectUpdates).length > 0) {
      const timestamp = new Date().toISOString();
      let applied = false;
      await this.projectRegistry.update(project.projectId, (current) => {
        if (current.archivedAt || current.rootPath !== project.rootPath) return current;
        applied = true;
        return { ...current, ...projectUpdates, updatedAt: timestamp };
      });
      if (applied)
        changes.push({
          kind: "project_updated",
          projectId: project.projectId,
          directory: project.rootPath,
          fields: projectUpdates,
        });
    }

    await Promise.all(
      workspaceCheckouts.map(async (entry) => {
        if (!entry) return;
        const { workspace, checkout: wsGit } = entry;
        const timestamp = new Date().toISOString();
        if (!reconcileWorkspacePlacement({ workspace, checkout: wsGit, updatedAt: timestamp }))
          return;
        let fields: Partial<MutableWorkspacePlacement> | null = null;
        await this.workspaceRegistry.update(workspace.workspaceId, (current) => {
          if (current.cwd !== workspace.cwd || current.projectId !== workspace.projectId)
            return current;
          const update = reconcileWorkspacePlacement({
            workspace: current,
            checkout: wsGit,
            updatedAt: timestamp,
          });
          if (!update) return current;
          fields = update.fields;
          return { ...current, ...fields, updatedAt: timestamp };
        });
        if (!fields) return;
        changes.push({
          kind: "workspace_updated",
          workspaceId: workspace.workspaceId,
          directory: workspace.cwd,
          fields,
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

  private wakeInspectionWaiters(): void {
    for (const wake of this.inspectionWaiters) wake();
    this.inspectionWaiters.clear();
  }

  private async inspectDirectory(targetPath: string): Promise<DirectoryState> {
    // A healthy in-flight inspection owns capacity temporarily. Wait for it;
    // only unresolved operations that have all timed out justify skipping paths.
    while (
      !this.disposed &&
      !this.pendingInspections.has(targetPath) &&
      this.pendingInspections.size >= INSPECTION_CONCURRENCY
    ) {
      if (this.timedOutPaths.size === INSPECTION_CONCURRENCY) return "unreadable";
      await new Promise<void>((resolve) => this.inspectionWaiters.add(resolve));
    }
    if (this.disposed) return "unreadable";
    let pending = this.pendingInspections.get(targetPath);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => this.directoryInspection(targetPath))
        .catch((error) => {
          if (isMissingPathError(error)) return "missing" as const;
          this.logger.warn(
            { err: error, targetPath },
            "Skipped workspace reconciliation after directory inspection failed",
          );
          return "unreadable" as const;
        })
        .finally(() => {
          this.pendingInspections.delete(targetPath);
          this.timedOutPaths.delete(targetPath);
          this.wakeInspectionWaiters();
          if (this.inspectionSaturated && this.timedOutPaths.size === 0) {
            this.inspectionSaturated = false;
            this.logger.info(
              {},
              "Timed-out workspace directory inspections drained; reconciliation capacity restored",
            );
          }
        });
      this.pendingInspections.set(targetPath, pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<DirectoryState>((resolve) => {
          timer = setTimeout(() => {
            this.timedOutPaths.add(targetPath);
            this.wakeInspectionWaiters();
            if (!this.inspectionSaturated && this.timedOutPaths.size === INSPECTION_CONCURRENCY) {
              this.inspectionSaturated = true;
              this.logger.warn(
                { paths: [...this.timedOutPaths] },
                "Workspace directory inspection saturated; preserving uninspected workspaces",
              );
            }
            this.logger.warn(
              { targetPath },
              "Skipped workspace reconciliation after directory inspection timed out",
            );
            resolve("unreadable");
          }, this.inspectionTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

// Two workers bound admission; yielding also bounds passes whose adapters settle
// immediately (including unavailable paths after both IO slots time out).
async function mapBounded<T, R>(items: T[], visit: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(INSPECTION_CONCURRENCY, items.length) }, async () => {
      let count = 0;
      while (next < items.length) {
        const index = next++;
        results[index] = await visit(items[index]!);
        if (++count % 32 === 0) await yieldToLoop();
      }
    }),
  );
  return results;
}
