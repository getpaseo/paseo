import { realpath, watch as watchPath } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import pLimit from "p-limit";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import type pino from "pino";
import type {
  ProjectRegistry,
  WorkspaceRegistry,
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { areEquivalentPaths, createPathContainmentMatcher } from "../utils/path.js";
import {
  deriveProjectKind,
  reconcileWorkspacePlacement,
  type MutableWorkspacePlacement,
} from "./workspace-registry-model.js";
import { workspaceIdsForProjects } from "./workspace-directory.js";
import { CheckoutReadSession } from "../utils/checkout-read-session.js";
import { getGitCommonDirForWorktreeRoot } from "../utils/worktree-metadata.js";
import { deriveProjectKey } from "./project-key.js";

const resolveRealpath = promisify(realpath);
const resolveNativeRealpath = promisify(realpath.native);

const DEFAULT_RESCAN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DEBOUNCE_MS = 100;
const INSPECTION_CONCURRENCY = 2;
// Each checkout read runs ~15 Git commands. Reading every sibling at once
// queued ~1,300 commands per rescan on a project with ~90 worktrees.
const CHECKOUT_READ_CONCURRENCY = 4;
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
  currentGit: ProjectCheckoutLitePayload | null;
  readCheckout: (cwd: string) => Promise<ProjectCheckoutLitePayload>;
  changes: ReconciliationChange[];
}

interface CachedCheckoutRead {
  cwd: string;
  checkout: Promise<ProjectCheckoutLitePayload>;
}

interface ResolvedPath {
  path: string;
  missing: boolean;
}

interface CheckoutDirectory {
  path: string;
  repository: { root: string; commonDir: ResolvedPath } | null;
}

type DirectoryInspection = DirectoryState | CheckoutDirectory;

export type DirectoryState = "directory" | "missing" | "unreadable";

export class WorkspaceReconciliationService {
  // Timed-out fs operations retain their slot until the OS returns. Never use
  // the deadline to admit more work into libuv's shared threadpool.
  private readonly timedOutPaths = new Map<string, string>();
  private inspectionSaturated = false;
  private readonly inspectionWaiters = new Set<() => void>();
  private readonly pendingInspections = new Map<string, Promise<DirectoryInspection>>();
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
  // Project roots whose `.git` changed since the last observed pass. A metadata
  // pass reads only these; the periodic full pass covers everything else.
  private readonly changedRoots = new Set<string>();
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

  /**
   * Reconciles mutable Git facts only; never archives missing records. With
   * `rootPaths`, read projects and workspaces whose checkouts can change under those paths.
   */
  async reconcileGitMetadata(options?: { rootPaths?: string[] }): Promise<ReconciliationResult> {
    const start = Date.now();
    const changes: ReconciliationChange[] = [];
    const [allProjects, workspaces] = await Promise.all([
      this.projectRegistry.list(),
      this.workspaceRegistry.listActive(),
    ]);
    const projects = allProjects.filter((project) => !project.archivedAt);
    const activeWorkspaces = workspaces.filter((workspace) => !workspace.archivedAt);
    const affectedDirectories = options?.rootPaths
      ? await findAffectedCheckoutDirectories(
          options.rootPaths,
          [
            ...projects.map((project) => project.rootPath),
            ...activeWorkspaces.map((workspace) => workspace.cwd),
          ],
          (path, read) => this.inspectPath(path, "scope", read),
        )
      : null;
    const isAffectedDirectory = (cwd: string) => affectedDirectories?.has(cwd) ?? true;
    const workspacesByProject = new Map<string, PersistedWorkspaceRecord[]>();
    const workspaceStates = await mapBounded(
      activeWorkspaces.filter((workspace) => isAffectedDirectory(workspace.cwd)),
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
      projects.filter(
        (project) =>
          isAffectedDirectory(project.rootPath) || workspacesByProject.has(project.projectId),
      ),
      async (project) => ({ project, state: await this.inspectDirectory(project.rootPath) }),
    );
    await this.reconcileGitMetadataForProjects(
      projectStates.filter(({ state }) => state === "directory").map(({ project }) => project),
      workspacesByProject,
      changes,
      isAffectedDirectory,
    );
    if (changes.length > 0) this.onChanges?.(changes);
    return { changesApplied: changes, durationMs: Date.now() - start };
  }

  async runOnce(): Promise<ReconciliationResult> {
    const start = Date.now();
    const changes: ReconciliationChange[] = [];

    const allProjects = await this.projectRegistry.list();
    const allWorkspaces = await this.workspaceRegistry.listActive();

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
    isAffectedDirectory: (cwd: string) => boolean = () => true,
  ): Promise<void> {
    const checkoutReads: CachedCheckoutRead[] = [];
    const checkoutReadLimit = pLimit(CHECKOUT_READ_CONCURRENCY);
    const readSession = new CheckoutReadSession();
    const readCheckout = (cwd: string): Promise<ProjectCheckoutLitePayload> => {
      const existing = checkoutReads.find((read) => areEquivalentPaths(read.cwd, cwd));
      if (existing) return existing.checkout;
      const checkout = checkoutReadLimit(() => this.readCheckout(cwd, readSession));
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
          const rootGit = isAffectedDirectory(rootPath) ? await readCheckout(rootPath) : null;
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
        if (!current || !isStillReconcilable(current, workspace)) return null;
        return { workspace: current, checkout: await readCheckout(current.cwd) };
      }),
    );
    const project = await this.projectRegistry.get(input.project.projectId);
    if (!project || project.archivedAt || project.rootPath !== input.project.rootPath) return;
    if (currentGit) await this.reconcileProjectMetadata(project, currentGit, changes);

    await Promise.all(
      workspaceCheckouts.map(async (entry) => {
        if (!entry) return;
        const { workspace, checkout: wsGit } = entry;
        const timestamp = new Date().toISOString();
        if (!reconcileWorkspacePlacement({ workspace, checkout: wsGit, updatedAt: timestamp }))
          return;
        let fields: Partial<MutableWorkspacePlacement> | null = null;
        await this.workspaceRegistry.update(workspace.workspaceId, (current) => {
          // Archive removes a worktree only after archiving its record, so a read
          // that raced the archive may have seen the directory mid-deletion.
          if (!isStillReconcilable(current, workspace)) return current;
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

  private async reconcileProjectMetadata(
    project: PersistedProjectRecord,
    currentGit: ProjectCheckoutLitePayload,
    changes: ReconciliationChange[],
  ): Promise<void> {
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
              this.changedRoots.add(project.rootPath);
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
    // Take the roots that changed so far. Events arriving during this pass
    // land in a fresh set and queue one more pass for just those roots.
    const rootPaths = [...this.changedRoots];
    this.changedRoots.clear();
    if (mode === "metadata" && rootPaths.length === 0) return;
    this.reconciling = true;
    try {
      await this.syncProjectRootWatches();
      const result =
        mode === "full" ? await this.runOnce() : await this.reconcileGitMetadata({ rootPaths });
      await this.publishChangedWorkspaces(result);
    } catch (error) {
      // A failed pass keeps its roots pending for the next pass.
      for (const rootPath of rootPaths) this.changedRoots.add(rootPath);
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

  private async publishChangedWorkspaces(result: ReconciliationResult): Promise<void> {
    const workspaceIds = new Set<string>();
    const projectIds = new Set<string>();
    for (const change of result.changesApplied) {
      if (change.kind === "workspace_updated" || change.kind === "workspace_archived") {
        workspaceIds.add(change.workspaceId);
      }
      if (change.kind === "project_updated") projectIds.add(change.projectId);
    }
    if (projectIds.size > 0) {
      const workspaces = await this.workspaceRegistry.listActive();
      for (const workspaceId of workspaceIdsForProjects(workspaces, projectIds)) {
        workspaceIds.add(workspaceId);
      }
    }
    if (!this.disposed && workspaceIds.size > 0) {
      await this.onWorkspacesChanged?.(Array.from(workspaceIds));
    }
  }

  private async readCheckout(
    cwd: string,
    readSession: CheckoutReadSession,
  ): Promise<ProjectCheckoutLitePayload> {
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
    // Reconciliation converges in the background; it must not queue ahead of
    // Git work a user is waiting for.
    return this.workspaceGitService.getCheckout(cwd, { priority: "background", readSession });
  }

  private wakeInspectionWaiters(): void {
    for (const wake of this.inspectionWaiters) wake();
    this.inspectionWaiters.clear();
  }

  private async inspectDirectory(targetPath: string): Promise<DirectoryState> {
    const result = await this.inspectPath(targetPath, "directory", () =>
      this.directoryInspection(targetPath),
    );
    return typeof result === "string" ? result : "directory";
  }

  private async inspectPath(
    targetPath: string,
    purpose: "directory" | "scope",
    read: () => Promise<DirectoryInspection>,
  ): Promise<DirectoryInspection> {
    const key = `${purpose}:${targetPath}`;
    // A healthy in-flight inspection owns capacity temporarily. Wait for it;
    // only unresolved operations that have all timed out justify skipping paths.
    while (
      !this.disposed &&
      !this.pendingInspections.has(key) &&
      this.pendingInspections.size >= INSPECTION_CONCURRENCY
    ) {
      if (this.timedOutPaths.size === INSPECTION_CONCURRENCY) return "unreadable";
      await new Promise<void>((resolve) => this.inspectionWaiters.add(resolve));
    }
    if (this.disposed) return "unreadable";
    let pending = this.pendingInspections.get(key);
    if (!pending) {
      pending = Promise.resolve()
        .then(read)
        .catch((error) => {
          if (isMissingPathError(error)) return "missing" as const;
          this.logger.warn(
            { err: error, targetPath },
            "Skipped workspace reconciliation after directory inspection failed",
          );
          return "unreadable" as const;
        })
        .finally(() => {
          this.pendingInspections.delete(key);
          this.timedOutPaths.delete(key);
          this.wakeInspectionWaiters();
          if (this.inspectionSaturated && this.timedOutPaths.size === 0) {
            this.inspectionSaturated = false;
            this.logger.info(
              {},
              "Timed-out workspace directory inspections drained; reconciliation capacity restored",
            );
          }
        });
      this.pendingInspections.set(key, pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<DirectoryInspection>((resolve) => {
          timer = setTimeout(() => {
            this.timedOutPaths.set(key, targetPath);
            this.wakeInspectionWaiters();
            if (!this.inspectionSaturated && this.timedOutPaths.size === INSPECTION_CONCURRENCY) {
              this.inspectionSaturated = true;
              this.logger.warn(
                { paths: [...this.timedOutPaths.values()] },
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

/**
 * Resolve saved directories for selection only. The registries keep their original paths.
 * Looking up the nearest .git entry and commondir uses bounded filesystem reads, so a
 * watcher event does not start Git processes in repositories it is about to exclude.
 */
async function findAffectedCheckoutDirectories(
  changedRoots: string[],
  candidates: string[],
  inspect: (path: string, read: () => Promise<CheckoutDirectory>) => Promise<DirectoryInspection>,
): Promise<Set<string>> {
  const resolved = new Map<string, Promise<ResolvedPath>>();
  const resolvePath = (targetPath: string): Promise<ResolvedPath> => {
    let result = resolved.get(targetPath);
    if (!result) {
      // Prefer the native resolver so Windows 8.3 short paths (e.g. RUNNER~1) canonicalize
      // to the same long path Git writes into linked worktree `.git` pointers.
      result = resolveNativeRealpath(targetPath)
        .catch((error) => {
          if (isMissingPathError(error)) throw error;
          return resolveRealpath(targetPath);
        })
        .then(
          (resolvedPath) => ({ path: resolvedPath, missing: false }),
          async (error) => {
            if (!isMissingPathError(error)) return { path: targetPath, missing: false };
            const parent = dirname(targetPath);
            if (parent === targetPath) return { path: targetPath, missing: true };
            const resolvedParent = await resolvePath(parent);
            return { path: join(resolvedParent.path, basename(targetPath)), missing: true };
          },
        );
      resolved.set(targetPath, result);
    }
    return result;
  };
  const gitDirectories = new Map<string, Promise<string | null>>();
  const findRepository = async (cwd: string): Promise<CheckoutDirectory["repository"]> => {
    for (let current = cwd; ; current = dirname(current)) {
      let result = gitDirectories.get(current);
      if (!result) {
        result = getGitCommonDirForWorktreeRoot(current);
        gitDirectories.set(current, result);
      }
      const gitDir = await result;
      if (gitDir) return { root: current, commonDir: await resolvePath(gitDir) };
      if (dirname(current) === current) return null;
    }
  };

  const inspectCheckoutDirectory = (directory: string) =>
    inspect(directory, async () => {
      const { path } = await resolvePath(directory);
      return { path, repository: await findRepository(path) };
    });
  const dirty = await mapBounded(changedRoots, inspectCheckoutDirectory);
  const roots = dirty.map((entry, index) =>
    typeof entry === "string" ? changedRoots[index]! : entry.path,
  );
  const tree = createPathContainmentMatcher({
    roots,
    compareAsWindows: process.platform === "win32",
  });
  const commonDirs = dirty.flatMap((entry) =>
    typeof entry !== "string" && entry.repository ? [entry.repository.commonDir.path] : [],
  );
  const gitEntries = createPathContainmentMatcher({
    roots: roots.map((root) => join(root, ".git")),
    compareAsWindows: process.platform === "win32",
  });
  const repositories = createPathContainmentMatcher({
    roots: commonDirs,
    compareAsWindows: process.platform === "win32",
  });
  const affected = new Set<string>();
  await mapBounded([...new Set(candidates)], async (candidate) => {
    const entry = await inspectCheckoutDirectory(candidate);
    const path = typeof entry === "string" ? candidate : entry.path;
    const repository = typeof entry === "string" ? null : entry.repository;
    const commonDir = repository?.commonDir;
    // A broken checkout can still point beneath the changed .git entry after
    // removal or replacement. Existing submodule metadata has its own identity.
    const sharesMetadata =
      commonDir &&
      (repositories.matchesExact(commonDir.path) ||
        (commonDir.missing && gitEntries.matches(commonDir.path)));
    // A surviving nested repository provides its own metadata even if its
    // parent gains or loses a .git entry.
    const hasIndependentNestedRepository =
      repository && tree.matches(repository.root) && !tree.matchesExact(repository.root);
    if (sharesMetadata || (tree.matches(path) && !hasIndependentNestedRepository)) {
      affected.add(candidate);
    }
  });
  return affected;
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

/** An archived record keeps the placement its restore depends on. */
function isStillReconcilable(
  current: PersistedWorkspaceRecord,
  scanned: PersistedWorkspaceRecord,
): boolean {
  return (
    !current.archivedAt && current.cwd === scanned.cwd && current.projectId === scanned.projectId
  );
}
