import { watch as watchPath } from "node:fs";

import type pino from "pino";

import { areEquivalentPaths } from "../utils/path.js";
import type { PersistedProjectRecord, ProjectRegistry } from "./workspace-registry.js";
import type { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";

const DEFAULT_RESCAN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DEBOUNCE_MS = 100;

export type ProjectGitObserverUpdate =
  | { kind: "upsert"; project: PersistedProjectRecord }
  | { kind: "remove"; projectId: string };

interface ProjectRootWatcher {
  close(): void;
}

interface ProjectRootWatch {
  (
    rootPath: string,
    options: { recursive: false },
    onChange: (event: string, filename: string | Buffer | null) => void,
    onError: (error: Error) => void,
  ): ProjectRootWatcher;
}

interface ObserverTimer {
  unref?(): void;
}

interface ObserverClock {
  setTimeout(callback: () => void | Promise<void>, delayMs: number): ObserverTimer;
  clearTimeout(timer: ObserverTimer): void;
  setInterval(callback: () => void | Promise<void>, delayMs: number): ObserverTimer;
  clearInterval(timer: ObserverTimer): void;
}

const systemClock: ObserverClock = {
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

/**
 * Daemon-owned, root-only Git metadata observation. This deliberately does not
 * use the working-tree watcher: projects may be empty and only `.git` matters.
 */
export class ProjectGitObserverService {
  private readonly watchers: Array<{ rootPath: string; watcher: ProjectRootWatcher }> = [];
  private unsubscribeRegistry: (() => void) | null = null;
  private rescanTimer: ObserverTimer | null = null;
  private debounceTimer: ObserverTimer | null = null;
  private disposed = false;
  private started = false;
  private reconciling = false;
  private queued = false;

  constructor(
    private readonly deps: {
      projectRegistry: ProjectRegistry;
      reconciliation: Pick<WorkspaceReconciliationService, "reconcileGitMetadata">;
      logger: pino.Logger;
      onProjectUpdate: (update: ProjectGitObserverUpdate) => void;
      onWorkspacesChanged: (workspaceIds: string[]) => Promise<void>;
      watch?: ProjectRootWatch;
      clock?: ObserverClock;
      rescanIntervalMs?: number;
      debounceMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeRegistry =
      this.deps.projectRegistry.subscribeToMutations?.(async (mutation) => {
        // The registry calls this before its mutator resolves, installing a root
        // watch before project.add can return and git init can race it.
        try {
          await this.sync();
          if (this.disposed) return;
          if (mutation.kind === "upsert" && mutation.project && !mutation.project.archivedAt) {
            this.deps.onProjectUpdate({ kind: "upsert", project: mutation.project });
          } else {
            this.deps.onProjectUpdate({ kind: "remove", projectId: mutation.projectId });
          }
        } catch (error) {
          this.deps.logger.warn({ err: error }, "Project Git observer mutation handling failed");
        }
      }) ?? null;
    await this.sync();
    const clock = this.deps.clock ?? systemClock;
    this.rescanTimer = clock.setInterval(
      () => this.reconcileSafe(),
      this.deps.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS,
    );
    this.rescanTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = null;
    const clock = this.deps.clock ?? systemClock;
    if (this.rescanTimer) clock.clearInterval(this.rescanTimer);
    if (this.debounceTimer) clock.clearTimeout(this.debounceTimer);
    for (const { watcher } of this.watchers) watcher.close();
    this.watchers.length = 0;
  }

  private async sync(): Promise<void> {
    if (this.disposed) return;
    const projects = await this.deps.projectRegistry.list();
    if (this.disposed) return;
    const active = projects.filter((project) => !project.archivedAt);
    for (let index = this.watchers.length - 1; index >= 0; index -= 1) {
      if (
        !active.some((project) =>
          areEquivalentPaths(project.rootPath, this.watchers[index]!.rootPath),
        )
      ) {
        this.watchers[index]!.watcher.close();
        this.watchers.splice(index, 1);
      }
    }
    for (const project of active) {
      if (this.watchers.some((target) => areEquivalentPaths(target.rootPath, project.rootPath)))
        continue;
      try {
        let watcher: ProjectRootWatcher;
        watcher = (this.deps.watch ?? watchProjectRoot)(
          project.rootPath,
          { recursive: false },
          (_event, filename) => {
            if (filename === null || filename.toString() === ".git") this.scheduleReconcile();
          },
          (error) => {
            watcher.close();
            const index = this.watchers.findIndex((target) => target.watcher === watcher);
            if (index >= 0) this.watchers.splice(index, 1);
            this.deps.logger.warn(
              { err: error, rootPath: project.rootPath },
              "Project root watch failed",
            );
          },
        );
        this.watchers.push({ rootPath: project.rootPath, watcher });
      } catch (error) {
        // The slow rescan is the convergence path for missing/unwatchable roots.
        this.deps.logger.debug(
          { err: error, rootPath: project.rootPath },
          "Project root is not watchable yet",
        );
      }
    }
  }

  private scheduleReconcile(): void {
    if (this.disposed || this.debounceTimer) return;
    this.debounceTimer = (this.deps.clock ?? systemClock).setTimeout(() => {
      this.debounceTimer = null;
      return this.reconcileSafe();
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return;
    if (this.reconciling) {
      this.queued = true;
      return;
    }
    this.reconciling = true;
    try {
      await this.sync();
      const result = await this.deps.reconciliation.reconcileGitMetadata();
      const workspaceIds = [
        ...new Set(
          result.changesApplied
            .filter(
              (change): change is Extract<typeof change, { kind: "workspace_updated" }> =>
                change.kind === "workspace_updated",
            )
            .map((change) => change.workspaceId),
        ),
      ];
      if (!this.disposed && workspaceIds.length > 0)
        await this.deps.onWorkspacesChanged(workspaceIds);
    } finally {
      this.reconciling = false;
      if (this.queued) {
        this.queued = false;
        void this.reconcileSafe();
      }
    }
  }

  private async reconcileSafe(): Promise<void> {
    try {
      await this.reconcile();
    } catch (error) {
      if (!this.disposed)
        this.deps.logger.warn({ err: error }, "Project Git metadata reconciliation failed");
    }
  }
}
