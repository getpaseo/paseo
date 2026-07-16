import type pino from "pino";
import { describe, expect, test } from "vitest";

import { ProjectGitObserverService, type ProjectUpdate } from "./project-git-observer-service.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
} from "./workspace-registry.js";
import type {
  ReconciliationChange,
  ReconciliationResult,
} from "./workspace-reconciliation-service.js";

const DEBOUNCE_MS = 10;
const RESCAN_INTERVAL_MS = 1_000;
const TIMESTAMP = "2026-07-15T00:00:00.000Z";

interface ProjectRegistryMutation {
  kind: "upsert" | "archive" | "remove";
  projectId: string;
  project: PersistedProjectRecord | null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function project(
  projectId: string,
  rootPath: string,
  archivedAt: string | null = null,
): PersistedProjectRecord {
  return createPersistedProjectRecord({
    projectId,
    rootPath,
    kind: "non_git",
    displayName: projectId,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    archivedAt,
  });
}

function workspace(workspaceId: string, projectId: string, cwd: string): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId,
    projectId,
    cwd,
    kind: "directory",
    displayName: workspaceId,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });
}

class FakeProjectRegistry implements ProjectRegistry {
  private readonly projects = new Map<string, PersistedProjectRecord>();
  private readonly listeners = new Set<
    (mutation: ProjectRegistryMutation) => void | Promise<void>
  >();
  private nextListGate: { started: Deferred<void>; release: Deferred<void> } | null = null;

  constructor(
    projects: PersistedProjectRecord[],
    private readonly lifecycle: string[],
  ) {
    for (const record of projects) this.projects.set(record.projectId, record);
  }

  async initialize(): Promise<void> {}

  async existsOnDisk(): Promise<boolean> {
    return true;
  }

  async list(): Promise<PersistedProjectRecord[]> {
    const gate = this.nextListGate;
    this.nextListGate = null;
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
    }
    return [...this.projects.values()];
  }

  async get(projectId: string): Promise<PersistedProjectRecord | null> {
    return this.projects.get(projectId) ?? null;
  }

  async getOrCreateActiveByRoot(): Promise<PersistedProjectRecord> {
    throw new Error("not used by the observer");
  }

  async upsert(record: PersistedProjectRecord): Promise<void> {
    this.projects.set(record.projectId, record);
    await this.publish({ kind: "upsert", projectId: record.projectId, project: record });
    this.lifecycle.push(`mutator resolved:upsert:${record.projectId}`);
  }

  async archive(projectId: string, archivedAt: string): Promise<void> {
    const existing = this.projects.get(projectId);
    if (!existing) return;
    const archived = { ...existing, archivedAt, updatedAt: archivedAt };
    this.projects.set(projectId, archived);
    await this.publish({ kind: "archive", projectId, project: archived });
    this.lifecycle.push(`mutator resolved:archive:${projectId}`);
  }

  async remove(projectId: string): Promise<void> {
    if (!this.projects.delete(projectId)) return;
    await this.publish({ kind: "remove", projectId, project: null });
    this.lifecycle.push(`mutator resolved:remove:${projectId}`);
  }

  subscribeToMutations(
    listener: (mutation: ProjectRegistryMutation) => void | Promise<void>,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  holdNextList(): { started: Promise<void>; release: () => void } {
    const gate = { started: deferred<void>(), release: deferred<void>() };
    this.nextListGate = gate;
    return { started: gate.started.promise, release: () => gate.release.resolve() };
  }

  get subscriptionCount(): number {
    return this.listeners.size;
  }

  private async publish(mutation: ProjectRegistryMutation): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(mutation)));
  }
}

interface FakeTimer {
  callback: () => void | Promise<void>;
  dueAt: number;
  intervalMs: number | null;
  sequence: number;
  cancelled: boolean;
  unref(): void;
}

class TestClock {
  private nowMs = 0;
  private sequence = 0;
  private readonly timers = new Set<FakeTimer>();

  setTimeout(callback: () => void | Promise<void>, delayMs: number): FakeTimer {
    return this.schedule(callback, delayMs, null);
  }

  clearTimeout(timer: FakeTimer): void {
    timer.cancelled = true;
    this.timers.delete(timer);
  }

  setInterval(callback: () => void | Promise<void>, delayMs: number): FakeTimer {
    return this.schedule(callback, delayMs, delayMs);
  }

  clearInterval(timer: FakeTimer): void {
    timer.cancelled = true;
    this.timers.delete(timer);
  }

  async advanceBy(elapsedMs: number): Promise<void> {
    const target = this.nowMs + elapsedMs;
    for (;;) {
      const next = [...this.timers]
        .filter((timer) => !timer.cancelled && timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.sequence - right.sequence)[0];
      if (!next) break;
      this.nowMs = next.dueAt;
      if (next.intervalMs === null) this.timers.delete(next);
      else next.dueAt += next.intervalMs;
      await next.callback();
    }
    this.nowMs = target;
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  private schedule(
    callback: () => void | Promise<void>,
    delayMs: number,
    intervalMs: number | null,
  ): FakeTimer {
    const timer: FakeTimer = {
      callback,
      dueAt: this.nowMs + delayMs,
      intervalMs,
      sequence: this.sequence,
      cancelled: false,
      unref: () => undefined,
    };
    this.sequence += 1;
    this.timers.add(timer);
    return timer;
  }
}

interface WatchInstallation {
  rootPath: string;
  recursive: false;
  watcher: FakeWatcher;
}

class FakeWatcher {
  closed = false;

  constructor(
    readonly onChange: (event: string, filename: string | Buffer | null) => void,
    readonly onError: (error: Error) => void,
  ) {}

  close(): void {
    this.closed = true;
  }
}

class FakeProjectRoots {
  readonly installations: WatchInstallation[] = [];
  private failures = new Map<string, Error[]>();

  constructor(private readonly lifecycle: string[]) {}

  readonly watch = (
    rootPath: string,
    options: { recursive: false },
    onChange: (event: string, filename: string | Buffer | null) => void,
    onError: (error: Error) => void,
  ): FakeWatcher => {
    const failures = this.failures.get(rootPath) ?? [];
    const failure = failures.shift();
    this.failures.set(rootPath, failures);
    if (failure) throw failure;
    const watcher = new FakeWatcher(onChange, onError);
    this.installations.push({ rootPath, recursive: options.recursive, watcher });
    this.lifecycle.push(`watch installed:${rootPath}`);
    return watcher;
  };

  change(rootPath: string, filename: string | Buffer | null): void {
    this.openWatcher(rootPath).onChange("rename", filename);
  }

  fail(rootPath: string, error: Error): void {
    this.openWatcher(rootPath).onError(error);
  }

  failNextInstall(rootPath: string, error: Error): void {
    const failures = this.failures.get(rootPath) ?? [];
    failures.push(error);
    this.failures.set(rootPath, failures);
  }

  get active(): Array<{ rootPath: string; recursive: false }> {
    return this.installations
      .filter((installation) => !installation.watcher.closed)
      .map(({ rootPath, recursive }) => ({ rootPath, recursive }));
  }

  get closedRoots(): string[] {
    return this.installations
      .filter((installation) => installation.watcher.closed)
      .map((installation) => installation.rootPath);
  }

  private openWatcher(rootPath: string): FakeWatcher {
    const installation = this.installations.find(
      (candidate) => candidate.rootPath === rootPath && !candidate.watcher.closed,
    );
    if (!installation) throw new Error(`No active watcher for ${rootPath}`);
    return installation.watcher;
  }
}

type ReconciliationRun = () => Promise<ReconciliationResult>;

class FakeGitMetadata {
  private readonly plannedRuns: ReconciliationRun[] = [];
  runs = 0;

  async reconcileGitMetadata(): Promise<ReconciliationResult> {
    this.runs += 1;
    const run = this.plannedRuns.shift();
    if (run) return run();
    return { changesApplied: [], durationMs: 0 };
  }

  runNext(run: ReconciliationRun): void {
    this.plannedRuns.push(run);
  }

  failNext(error: Error): void {
    this.plannedRuns.push(async () => {
      throw error;
    });
  }

  holdNext(changesApplied: ReconciliationChange[]): {
    started: Promise<void>;
    release: () => void;
  } {
    const started = deferred<void>();
    const release = deferred<void>();
    this.plannedRuns.push(async () => {
      started.resolve();
      await release.promise;
      return { changesApplied, durationMs: 0 };
    });
    return { started: started.promise, release: () => release.resolve() };
  }
}

interface LogRecord {
  level: "debug" | "warn";
  payload: unknown;
  message: string;
}

function capturingLogger(records: LogRecord[]): pino.Logger {
  const logger = {
    child: () => logger,
    trace: () => undefined,
    debug: (payload: unknown, message: string) =>
      records.push({ level: "debug", payload, message }),
    info: () => undefined,
    warn: (payload: unknown, message: string) => records.push({ level: "warn", payload, message }),
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

class ObservedProjects {
  private readonly lifecycleEvents: string[] = [];
  private readonly clock = new TestClock();
  private readonly roots = new FakeProjectRoots(this.lifecycleEvents);
  private readonly registry: FakeProjectRegistry;
  private readonly gitMetadata = new FakeGitMetadata();
  private readonly projectEvents: ProjectUpdate[] = [];
  private readonly workspaceEvents: string[][] = [];
  private readonly logRecords: LogRecord[] = [];
  private readonly service: ProjectGitObserverService;

  constructor(
    initialProjects: PersistedProjectRecord[],
    private readonly workspaces: PersistedWorkspaceRecord[] = [],
  ) {
    this.registry = new FakeProjectRegistry(initialProjects, this.lifecycleEvents);
    this.service = new ProjectGitObserverService({
      projectRegistry: this.registry,
      workspaceRegistry: { list: async () => this.workspaces },
      reconciliation: this.gitMetadata,
      logger: capturingLogger(this.logRecords),
      onProjectUpdate: (update) => {
        this.projectEvents.push(update);
        const projectId = update.kind === "upsert" ? update.project.projectId : update.projectId;
        this.lifecycleEvents.push(`project published:${update.kind}:${projectId}`);
      },
      onWorkspacesChanged: async (workspaceIds) => {
        this.workspaceEvents.push(workspaceIds);
      },
      watch: this.roots.watch,
      clock: this.clock,
      debounceMs: DEBOUNCE_MS,
      rescanIntervalMs: RESCAN_INTERVAL_MS,
    });
  }

  async start(): Promise<void> {
    await this.service.start();
  }

  async startAgain(): Promise<void> {
    await this.service.start();
  }

  dispose(): void {
    this.service.dispose();
  }

  async add(record: PersistedProjectRecord): Promise<void> {
    await this.registry.upsert(record);
  }

  async archive(projectId: string): Promise<void> {
    await this.registry.archive(projectId, TIMESTAMP);
  }

  async remove(projectId: string): Promise<void> {
    await this.registry.remove(projectId);
  }

  change(rootPath: string, filename: string | Buffer | null): void {
    this.roots.change(rootPath, filename);
  }

  watcherFailed(rootPath: string, error: Error): void {
    this.roots.fail(rootPath, error);
  }

  failNextWatch(rootPath: string, error: Error): void {
    this.roots.failNextInstall(rootPath, error);
  }

  async advanceBy(elapsedMs: number): Promise<void> {
    await this.clock.advanceBy(elapsedMs);
  }

  failNextReconciliation(error: Error): void {
    this.gitMetadata.failNext(error);
  }

  holdNextRegistryRead(): { started: Promise<void>; release: () => void } {
    return this.registry.holdNextList();
  }

  holdNextReconciliation(changesApplied: ReconciliationChange[]): {
    started: Promise<void>;
    release: () => void;
  } {
    return this.gitMetadata.holdNext(changesApplied);
  }

  reconcileNextWithProjectUpdate(
    updatedProject: PersistedProjectRecord,
    changesApplied: ReconciliationChange[],
  ): void {
    this.gitMetadata.runNext(async () => {
      await this.registry.upsert(updatedProject);
      return { changesApplied, durationMs: 0 };
    });
  }

  clearLifecycle(): void {
    this.lifecycleEvents.length = 0;
  }

  get watchedRoots(): Array<{ rootPath: string; recursive: false }> {
    return this.roots.active;
  }

  get closedRoots(): string[] {
    return this.roots.closedRoots;
  }

  get pendingTimerCount(): number {
    return this.clock.pendingCount;
  }

  get subscriptionCount(): number {
    return this.registry.subscriptionCount;
  }

  get lifecycle(): string[] {
    return [...this.lifecycleEvents];
  }

  get publishedProjects(): ProjectUpdate[] {
    return [...this.projectEvents];
  }

  get publishedWorkspaceBatches(): string[][] {
    return this.workspaceEvents.map((workspaceIds) => [...workspaceIds]);
  }

  get reconciliationRuns(): number {
    return this.gitMetadata.runs;
  }

  get warnings(): LogRecord[] {
    return this.logRecords.filter((record) => record.level === "warn");
  }

  get debugLogs(): LogRecord[] {
    return this.logRecords.filter((record) => record.level === "debug");
  }
}

describe("ProjectGitObserverService", () => {
  test("starts one non-recursive watch per active lexical root and starts only once", async () => {
    const projects = new ObservedProjects([
      project("project-one", "/work/repo"),
      project("project-duplicate", "/work/repo/./"),
      project("project-two", "/work/other"),
      project("project-archived", "/work/archived", TIMESTAMP),
    ]);

    await projects.start();
    await projects.startAgain();

    expect(projects.watchedRoots).toEqual([
      { rootPath: "/work/repo", recursive: false },
      { rootPath: "/work/other", recursive: false },
    ]);
    expect(projects.pendingTimerCount).toBe(1);
    expect(projects.subscriptionCount).toBe(1);
    projects.dispose();
  });

  test("installs a newly added project's watch and publishes its upsert before add resolves", async () => {
    const projects = new ObservedProjects([]);
    await projects.start();
    projects.clearLifecycle();
    const added = project("project-new", "/work/new");

    await projects.add(added);

    expect(projects.lifecycle).toEqual([
      "watch installed:/work/new",
      "project published:upsert:project-new",
      "mutator resolved:upsert:project-new",
    ]);
    expect(projects.publishedProjects).toEqual([{ kind: "upsert", project: added }]);
    projects.dispose();
  });

  test("tears down archived and removed project watches and publishes exact removes", async () => {
    const archivedProject = project("project-archive", "/work/archive");
    const removedProject = project("project-remove", "/work/remove");
    const projects = new ObservedProjects([archivedProject, removedProject]);
    await projects.start();

    await projects.archive(archivedProject.projectId);
    await projects.remove(removedProject.projectId);

    expect(projects.watchedRoots).toEqual([]);
    expect(projects.closedRoots).toEqual(["/work/archive", "/work/remove"]);
    expect(projects.publishedProjects).toEqual([
      { kind: "remove", projectId: "project-archive" },
      { kind: "remove", projectId: "project-remove" },
    ]);
    projects.dispose();
  });

  test("ignores unrelated filenames and coalesces .git and unknown-filename bursts", async () => {
    const projects = new ObservedProjects([project("project-one", "/work/repo")]);
    await projects.start();

    projects.change("/work/repo", "README.md");
    await projects.advanceBy(DEBOUNCE_MS);
    expect(projects.reconciliationRuns).toBe(0);

    projects.change("/work/repo", ".git");
    projects.change("/work/repo", ".git");
    projects.change("/work/repo", ".git");
    await projects.advanceBy(DEBOUNCE_MS);
    expect(projects.reconciliationRuns).toBe(1);

    projects.change("/work/repo", null);
    await projects.advanceBy(DEBOUNCE_MS);
    expect(projects.reconciliationRuns).toBe(2);
    projects.dispose();
  });

  test("drops an errored watch and recreates it on the periodic rescan", async () => {
    const projects = new ObservedProjects([project("project-one", "/work/repo")]);
    await projects.start();
    const watchError = new Error("watch failed");

    projects.watcherFailed("/work/repo", watchError);

    expect(projects.watchedRoots).toEqual([]);
    expect(projects.closedRoots).toEqual(["/work/repo"]);
    expect(projects.warnings).toEqual([
      {
        level: "warn",
        payload: { err: watchError, rootPath: "/work/repo" },
        message: "Project root watch failed",
      },
    ]);

    await projects.advanceBy(RESCAN_INTERVAL_MS);

    expect(projects.watchedRoots).toEqual([{ rootPath: "/work/repo", recursive: false }]);
    expect(projects.reconciliationRuns).toBe(1);
    projects.dispose();
  });

  test("retries a root that becomes watchable before the periodic rescan", async () => {
    const projects = new ObservedProjects([project("project-one", "/work/repo")]);
    const installError = new Error("root unavailable");
    projects.failNextWatch("/work/repo", installError);

    await projects.start();

    expect(projects.watchedRoots).toEqual([]);
    expect(projects.debugLogs).toEqual([
      {
        level: "debug",
        payload: { err: installError, rootPath: "/work/repo" },
        message: "Project root is not watchable yet",
      },
    ]);

    await projects.advanceBy(RESCAN_INTERVAL_MS);

    expect(projects.watchedRoots).toEqual([{ rootPath: "/work/repo", recursive: false }]);
    expect(projects.reconciliationRuns).toBe(1);
    projects.dispose();
  });

  test("contains and logs a reconciliation failure so later changes still converge", async () => {
    const projects = new ObservedProjects([project("project-one", "/work/repo")]);
    await projects.start();
    const reconciliationError = new Error("git metadata unavailable");
    projects.failNextReconciliation(reconciliationError);

    projects.change("/work/repo", ".git");
    await projects.advanceBy(DEBOUNCE_MS);

    expect(projects.warnings).toEqual([
      {
        level: "warn",
        payload: { err: reconciliationError },
        message: "Project Git metadata reconciliation failed",
      },
    ]);
    expect(projects.watchedRoots).toEqual([{ rootPath: "/work/repo", recursive: false }]);

    projects.change("/work/repo", ".git");
    await projects.advanceBy(DEBOUNCE_MS);
    expect(projects.reconciliationRuns).toBe(2);
    projects.dispose();
  });

  test("publishes a capable project update and fans its workspaces out for legacy clients", async () => {
    const original = project("project-one", "/work/repo");
    const updated = { ...original, kind: "git" as const };
    const projects = new ObservedProjects(
      [original],
      [
        workspace("workspace-one", original.projectId, "/work/repo"),
        workspace("workspace-two", original.projectId, "/work/repo/feature"),
        workspace("workspace-other", "project-other", "/work/other"),
      ],
    );
    await projects.start();
    projects.reconcileNextWithProjectUpdate(updated, [
      {
        kind: "project_updated",
        projectId: original.projectId,
        directory: original.rootPath,
        fields: { kind: "git" },
      },
    ]);

    projects.change(original.rootPath, ".git");
    await projects.advanceBy(DEBOUNCE_MS);

    expect(projects.publishedProjects).toEqual([{ kind: "upsert", project: updated }]);
    expect(projects.publishedWorkspaceBatches).toEqual([["workspace-one", "workspace-two"]]);
    projects.dispose();
  });

  test("deduplicates direct and project-derived workspace fanout", async () => {
    const original = project("project-one", "/work/repo");
    const projects = new ObservedProjects(
      [original],
      [
        workspace("workspace-one", original.projectId, "/work/repo"),
        workspace("workspace-two", original.projectId, "/work/repo/feature"),
      ],
    );
    await projects.start();
    projects.reconcileNextWithProjectUpdate(original, [
      {
        kind: "project_updated",
        projectId: original.projectId,
        directory: original.rootPath,
        fields: { kind: "git" },
      },
      {
        kind: "workspace_updated",
        workspaceId: "workspace-one",
        directory: "/work/repo",
        fields: { branch: "main" },
      },
      {
        kind: "workspace_updated",
        workspaceId: "workspace-one",
        directory: "/work/repo/.",
        fields: { kind: "local_checkout" },
      },
    ]);

    projects.change(original.rootPath, ".git");
    await projects.advanceBy(DEBOUNCE_MS);

    expect(projects.publishedWorkspaceBatches).toEqual([["workspace-one", "workspace-two"]]);
    projects.dispose();
  });

  test("does not feed an authoritative registry mutation back into metadata reconciliation", async () => {
    const projects = new ObservedProjects([]);
    await projects.start();

    await projects.add(project("project-new", "/work/new"));
    await projects.advanceBy(DEBOUNCE_MS);

    expect(projects.watchedRoots).toEqual([{ rootPath: "/work/new", recursive: false }]);
    expect(projects.publishedProjects).toEqual([
      {
        kind: "upsert",
        project: project("project-new", "/work/new"),
      },
    ]);
    expect(projects.reconciliationRuns).toBe(0);
    projects.dispose();
  });

  test("dispose closes watches, timers, and subscription while suppressing an in-flight mutation", async () => {
    const projects = new ObservedProjects([project("project-one", "/work/repo")]);
    await projects.start();
    projects.change("/work/repo", ".git");
    const registryRead = projects.holdNextRegistryRead();
    const adding = projects.add(project("project-late", "/work/late"));
    await registryRead.started;

    projects.dispose();
    registryRead.release();
    await adding;

    expect(projects.watchedRoots).toEqual([]);
    expect(projects.closedRoots).toEqual(["/work/repo"]);
    expect(projects.pendingTimerCount).toBe(0);
    expect(projects.subscriptionCount).toBe(0);
    expect(projects.publishedProjects).toEqual([]);
  });

  test("dispose suppresses workspace fanout from an in-flight reconciliation", async () => {
    const projects = new ObservedProjects([project("project-one", "/work/repo")]);
    await projects.start();
    const reconciliation = projects.holdNextReconciliation([
      {
        kind: "workspace_updated",
        workspaceId: "workspace-late",
        directory: "/work/repo",
        fields: { branch: "main" },
      },
    ]);
    projects.change("/work/repo", ".git");
    const advancing = projects.advanceBy(DEBOUNCE_MS);
    await reconciliation.started;

    projects.dispose();
    reconciliation.release();
    await advancing;

    expect(projects.publishedWorkspaceBatches).toEqual([]);
    expect(projects.pendingTimerCount).toBe(0);
    expect(projects.subscriptionCount).toBe(0);
    expect(projects.watchedRoots).toEqual([]);
  });
});
