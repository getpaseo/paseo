import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { areEquivalentPaths } from "../utils/path.js";
import {
  WorkspaceGitServiceImpl,
  type WorkspaceGitCheckoutReadOptions,
} from "./workspace-git-service.js";
import { deriveProjectKey } from "./project-key.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import {
  type ProjectRootWatch,
  type ProjectUpdate,
  type ReconciliationClock,
  type ReconciliationTimer,
  WorkspaceReconciliationService,
} from "./workspace-reconciliation-service.js";

const TIMESTAMP = "2026-07-15T00:00:00.000Z";
const DEBOUNCE_MS = 10;
const RESCAN_INTERVAL_MS = 50;
const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) rmSync(target, { recursive: true, force: true });
});

interface ProjectSpec {
  id: string;
  root: string;
  workspaces?: Array<{ id: string; cwd: string }>;
  archived?: boolean;
}

interface Gate {
  started: Promise<void>;
  release(): void;
}

function createGate(): Gate & { arrive(): Promise<void> } {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return { started, release, arrive: async () => (markStarted(), released) };
}

class ObservedProjectRegistry extends FileBackedProjectRegistry {
  private nextRead: ReturnType<typeof createGate> | null = null;

  holdNextRead(): Gate {
    return (this.nextRead = createGate());
  }

  override async list() {
    if (this.nextRead) {
      const pending = this.nextRead;
      this.nextRead = null;
      await pending.arrive();
    }
    return super.list();
  }
}

class ObservedWorkspaceRegistry extends FileBackedWorkspaceRegistry {
  private nextRead: ReturnType<typeof createGate> | null = null;
  private nextError: Error | null = null;

  holdNextRead(): Gate {
    return (this.nextRead = createGate());
  }

  failNextRead(error: Error): void {
    this.nextError = error;
  }

  override async listActive() {
    if (this.nextRead) {
      const pending = this.nextRead;
      this.nextRead = null;
      await pending.arrive();
    }
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    return super.listActive();
  }
}

interface TestTimer extends ReconciliationTimer {
  callback: () => void | Promise<void>;
  dueAt: number;
  intervalMs: number | null;
}

class TestClock implements ReconciliationClock {
  private now = 0;
  private readonly timers = new Set<TestTimer>();

  get pendingCount(): number {
    return this.timers.size;
  }

  setTimeout(callback: () => void | Promise<void>, delayMs: number): TestTimer {
    return this.add(callback, delayMs, null);
  }

  clearTimeout(timer: TestTimer): void {
    this.timers.delete(timer);
  }

  setInterval(callback: () => void | Promise<void>, delayMs: number): TestTimer {
    return this.add(callback, delayMs, delayMs);
  }

  clearInterval(timer: TestTimer): void {
    this.timers.delete(timer);
  }

  async advanceBy(elapsedMs: number): Promise<void> {
    const target = this.now + elapsedMs;
    for (;;) {
      const next = [...this.timers]
        .filter((timer) => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!next) break;
      this.now = next.dueAt;
      if (next.intervalMs === null) this.timers.delete(next);
      else next.dueAt += next.intervalMs;
      await next.callback();
    }
    this.now = target;
  }

  private add(
    callback: () => void | Promise<void>,
    delayMs: number,
    intervalMs: number | null,
  ): TestTimer {
    const timer = { callback, dueAt: this.now + delayMs, intervalMs, unref: () => undefined };
    this.timers.add(timer);
    return timer;
  }
}

interface RootWatch {
  rootPath: string;
  onChange: (event: string, filename: string | Buffer | null) => void;
  onError: (error: Error) => void;
  closed: boolean;
}

/** One public behavioral seam for the complete observed-placement lifecycle. */
class ObservedPlacements {
  private readonly home = mkdtempSync(path.join(tmpdir(), "observed-placement-"));
  private readonly projects: ObservedProjectRegistry;
  private readonly workspaces: ObservedWorkspaceRegistry;
  private readonly clock = new TestClock();
  private readonly watches: RootWatch[] = [];
  private readonly checkoutByCwd = new Map<string, ProjectCheckoutLitePayload>();
  private readonly rootByProjectId = new Map<string, string>();
  private readonly failedWatchRoots = new Set<string>();
  private readonly projectEvents: ProjectUpdate[] = [];
  private readonly workspaceEvents: string[][] = [];
  private readonly workspaceEventWaiters: Array<() => void> = [];
  private readonly lifecycleEvents: string[] = [];
  private readonly service: WorkspaceReconciliationService;
  private started = false;
  private checkoutReadCount = 0;
  private readonly checkoutReadCwds: string[] = [];

  private readonly gitService: WorkspaceGitServiceImpl | null;

  constructor(
    private readonly specs: ProjectSpec[],
    realGit = false,
  ) {
    cleanupPaths.push(this.home);
    const logger = createTestLogger();
    this.gitService = realGit
      ? new WorkspaceGitServiceImpl({ logger, paseoHome: this.absolute("paseo-home") })
      : null;
    this.projects = new ObservedProjectRegistry(path.join(this.home, "projects.json"), logger);
    this.workspaces = new ObservedWorkspaceRegistry(
      path.join(this.home, "workspaces.json"),
      logger,
    );
    const watchProjectRoot: ProjectRootWatch = (rootPath, _options, onChange, onError) => {
      if (this.failedWatchRoots.delete(rootPath)) throw new Error("root unavailable");
      const watch = { rootPath, onChange, onError, closed: false };
      this.watches.push(watch);
      this.lifecycleEvents.push(`watch installed:${path.relative(this.home, rootPath)}`);
      return { close: () => (watch.closed = true) };
    };
    this.service = new WorkspaceReconciliationService({
      projectRegistry: this.projects,
      workspaceRegistry: this.workspaces,
      workspaceGitService: { getCheckout: async (cwd, options) => this.readCheckout(cwd, options) },
      logger,
      watchProjectRoot,
      clock: this.clock,
      debounceMs: DEBOUNCE_MS,
      rescanIntervalMs: RESCAN_INTERVAL_MS,
      onProjectUpdate: (update) => {
        this.projectEvents.push(update);
        this.lifecycleEvents.push(
          update.kind === "upsert"
            ? `project published:upsert:${update.project.projectId}`
            : `project published:remove:${update.projectId}`,
        );
      },
      onWorkspacesChanged: async (workspaceIds) => {
        this.workspaceEvents.push(workspaceIds);
        this.workspaceEventWaiters.shift()?.();
      },
    });
  }

  async start(): Promise<void> {
    if (!this.started) {
      for (const spec of this.specs) await this.seed(spec);
      this.started = true;
    }
    await this.service.start();
  }

  async add(spec: ProjectSpec): Promise<void> {
    await this.seed(spec);
    this.lifecycleEvents.push(`registry mutation resolved:${spec.id}`);
  }

  async archive(projectId: string): Promise<void> {
    await this.projects.archive(projectId, TIMESTAMP);
  }

  async remove(projectId: string): Promise<void> {
    await this.projects.remove(projectId);
  }

  failNextWatch(root: string): void {
    this.failedWatchRoots.add(this.absolute(root));
  }

  watcherFailed(root: string): void {
    this.activeWatch(root)?.onError(new Error("watch failed"));
  }

  change(root: string, filename: string | null): void {
    this.activeWatch(root)?.onChange("rename", filename);
  }

  git(root: string, ...args: string[]): void {
    execFileSync("git", args, { cwd: this.absolute(root), stdio: "pipe" });
  }

  rename(from: string, to: string): void {
    renameSync(this.absolute(from), this.absolute(to));
  }

  link(alias: string, target: string): void {
    symlinkSync(
      this.absolute(target),
      this.absolute(alias),
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  async project(projectId: string) {
    return this.projects.get(projectId);
  }

  async disposeGit(): Promise<void> {
    this.dispose();
    await this.gitService?.dispose();
  }

  makeProjectGit(projectId: string, branch = "main"): void {
    const rootPath = this.rootByProjectId.get(projectId);
    if (!rootPath) throw new Error(`Unknown project: ${projectId}`);
    this.checkoutByCwd.set(rootPath, {
      cwd: rootPath,
      isGit: true,
      currentBranch: branch,
      remoteUrl: null,
      worktreeRoot: rootPath,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    });
  }

  failNextReconciliation(error: Error): void {
    this.workspaces.failNextRead(error);
  }

  holdNextRegistryRead(): Gate {
    return this.projects.holdNextRead();
  }

  holdNextReconciliation(): Gate {
    return this.workspaces.holdNextRead();
  }

  async advanceBy(elapsedMs: number): Promise<void> {
    await this.clock.advanceBy(elapsedMs);
  }

  dispose(): void {
    this.service.dispose();
  }

  watchedRoots(): string[] {
    return this.watches
      .filter((watch) => !watch.closed)
      .map((watch) => path.relative(this.home, watch.rootPath));
  }

  closedRoots(): string[] {
    return this.watches
      .filter((watch) => watch.closed)
      .map((watch) => path.relative(this.home, watch.rootPath));
  }

  async placement(workspaceId: string): Promise<PersistedWorkspaceRecord | null> {
    return this.workspaces.get(workspaceId);
  }

  async deleteWorkspaceDirectory(workspaceId: string): Promise<void> {
    const workspace = await this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    rmSync(workspace.cwd, { recursive: true, force: true });
  }

  get projectUpdates(): ProjectUpdate[] {
    return [...this.projectEvents];
  }

  get workspaceBatches(): string[][] {
    return this.workspaceEvents.map((batch) => [...batch]);
  }

  waitForWorkspaceBatch(): Promise<void> {
    return new Promise((resolve) => this.workspaceEventWaiters.push(resolve));
  }

  get lifecycle(): string[] {
    return [...this.lifecycleEvents];
  }

  get gitReads(): number {
    return this.checkoutReadCount;
  }

  /** Home-relative directories read since the last call, with portable separators. */
  takeCheckoutReads(): string[] {
    return this.checkoutReadCwds.splice(0).sort();
  }

  get pendingTimers(): number {
    return this.clock.pendingCount;
  }

  private async seed(spec: ProjectSpec): Promise<void> {
    const rootPath = this.absolute(spec.root);
    mkdirSync(rootPath, { recursive: true });
    this.rootByProjectId.set(spec.id, rootPath);
    await this.projects.upsert(
      createPersistedProjectRecord({
        projectId: spec.id,
        rootPath,
        kind: "non_git",
        // Seeded records already carry the key reconciliation derives, so a fixture's
        // first pass reports only what its test is about.
        projectKey: deriveProjectKey({
          rootPath,
          remoteUrl: null,
          worktreeRoot: null,
          mainRepoRoot: null,
        }),
        displayName: spec.id,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        archivedAt: spec.archived ? TIMESTAMP : null,
      }),
    );
    for (const workspace of spec.workspaces ?? []) {
      const cwd = this.absolute(workspace.cwd);
      mkdirSync(cwd, { recursive: true });
      await this.workspaces.upsert(
        createPersistedWorkspaceRecord({
          workspaceId: workspace.id,
          projectId: spec.id,
          cwd,
          kind: "directory",
          displayName: `Durable ${workspace.id}`,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        }),
      );
    }
  }

  private async readCheckout(
    cwd: string,
    options?: WorkspaceGitCheckoutReadOptions,
  ): Promise<ProjectCheckoutLitePayload> {
    this.checkoutReadCount += 1;
    this.checkoutReadCwds.push(path.relative(this.home, cwd).split(path.sep).join("/"));
    if (this.gitService) return this.gitService.getCheckout(cwd, options);
    const configured = [...this.checkoutByCwd.entries()].find(([root]) =>
      areEquivalentPaths(root, cwd),
    )?.[1];
    return (
      configured ?? {
        cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }
    );
  }

  private activeWatch(root: string): RootWatch | undefined {
    const target = this.absolute(root);
    return this.watches.find(
      (watch) => !watch.closed && areEquivalentPaths(watch.rootPath, target),
    );
  }

  private absolute(relative: string): string {
    return path.join(this.home, relative);
  }
}

/** Projects `a`, `b` and `c`, each rooted at `repo-<name>` with its own worktrees. */
function threeProjects(worktreeCount: number): ProjectSpec[] {
  return ["a", "b", "c"].map((name) => ({
    id: `project-${name}`,
    root: `repo-${name}`,
    workspaces: Array.from({ length: worktreeCount }, (_, index) => ({
      id: `${name}${index + 1}`,
      cwd: `repo-${name}/worktree-${index + 1}`,
    })),
  }));
}

describe("observed workspace placement", () => {
  test("installs and publishes a new project before add resolves without Git feedback", async () => {
    const observed = new ObservedPlacements([]);
    await observed.start();

    await observed.add({ id: "project-new", root: "new" });
    await observed.advanceBy(DEBOUNCE_MS);

    expect(observed.watchedRoots()).toEqual(["new"]);
    expect(observed.projectUpdates).toEqual([
      { kind: "upsert", project: expect.objectContaining({ projectId: "project-new" }) },
    ]);
    expect(observed.lifecycle).toEqual([
      "watch installed:new",
      "project published:upsert:project-new",
      "registry mutation resolved:project-new",
    ]);
    expect(observed.gitReads).toBe(0);
    observed.dispose();
  });

  test("deduplicates active root watches and tears them down on archive and remove", async () => {
    const observed = new ObservedPlacements([
      { id: "project-one", root: "repo" },
      { id: "project-duplicate", root: "repo" },
      { id: "project-remove", root: "other" },
      { id: "project-archived", root: "archived", archived: true },
    ]);

    await observed.start();
    await observed.start();
    expect(observed.watchedRoots()).toEqual(["repo", "other"]);

    await observed.archive("project-one");
    expect(observed.watchedRoots()).toEqual(["repo", "other"]);
    await observed.remove("project-duplicate");
    await observed.remove("project-remove");

    expect(observed.watchedRoots()).toEqual([]);
    expect(observed.closedRoots()).toEqual(["repo", "other"]);
    expect(observed.projectUpdates).toEqual([
      { kind: "remove", projectId: "project-one" },
      { kind: "remove", projectId: "project-duplicate" },
      { kind: "remove", projectId: "project-remove" },
    ]);
    observed.dispose();
  });

  test("filters unrelated files and coalesces Git change bursts", async () => {
    const observed = new ObservedPlacements([{ id: "project-one", root: "repo" }]);
    await observed.start();

    observed.change("repo", "README.md");
    await observed.advanceBy(DEBOUNCE_MS);
    expect(observed.gitReads).toBe(0);

    observed.change("repo", ".git");
    observed.change("repo", ".git");
    observed.change("repo", null);
    await observed.advanceBy(DEBOUNCE_MS);
    expect(observed.gitReads).toBe(1);
    observed.dispose();
  });

  test("reads only the workspaces of the project whose Git directory changed", async () => {
    const observed = new ObservedPlacements(threeProjects(3));
    await observed.start();

    observed.change("repo-b", ".git");
    await observed.advanceBy(DEBOUNCE_MS);

    expect(observed.takeCheckoutReads()).toEqual([
      "repo-b",
      "repo-b/worktree-1",
      "repo-b/worktree-2",
      "repo-b/worktree-3",
    ]);
    observed.dispose();
  });

  test("updates nested projects and workspaces when a parent directory becomes a Git repository", async () => {
    const observed = new ObservedPlacements([
      { id: "parent", root: "repo", workspaces: [{ id: "parent-ws", cwd: "repo" }] },
      { id: "nested", root: "repo/sub", workspaces: [{ id: "nested-ws", cwd: "repo/sub" }] },
      { id: "outside", root: "outside", workspaces: [{ id: "attached-ws", cwd: "repo/sub" }] },
      { id: "unrelated", root: "repo-other" },
    ]);
    await observed.start();
    try {
      observed.makeProjectGit("parent");
      observed.makeProjectGit("nested");

      observed.change("repo", ".git");
      await observed.advanceBy(DEBOUNCE_MS);

      expect(observed.projectUpdates).toContainEqual({
        kind: "upsert",
        project: expect.objectContaining({ projectId: "nested", kind: "git" }),
      });
      expect(await observed.placement("nested-ws")).toMatchObject({ kind: "local_checkout" });
      expect(await observed.placement("attached-ws")).toMatchObject({ kind: "local_checkout" });
      expect(observed.workspaceBatches.map((batch) => batch.sort())).toEqual([
        ["attached-ws", "nested-ws", "parent-ws"],
      ]);
      expect(observed.takeCheckoutReads()).toEqual(["repo", "repo/sub"]);
    } finally {
      observed.dispose();
    }
  });

  test("updates a separately registered directory alias when its parent becomes a Git repo", async () => {
    const observed = new ObservedPlacements([{ id: "repo", root: "repo" }], true);
    try {
      await observed.start();
      await observed.add({ id: "sub", root: "repo/sub" });
      observed.link("alias", "repo/sub");
      await observed.add({
        id: "alias",
        root: "alias",
        workspaces: [{ id: "alias-ws", cwd: "alias" }],
      });
      const savedProject = await observed.project("alias");
      const savedWorkspace = await observed.placement("alias-ws");
      observed.git("repo", "init", "-b", "main");
      observed.change("repo", ".git");
      await observed.advanceBy(DEBOUNCE_MS);

      expect(await observed.project("alias")).toMatchObject({
        kind: "git",
        rootPath: savedProject?.rootPath,
      });
      expect(await observed.placement("alias-ws")).toMatchObject({
        kind: "local_checkout",
        cwd: savedWorkspace?.cwd,
      });
      expect(observed.workspaceBatches.flat()).toContain("alias-ws");
    } finally {
      await observed.disposeGit();
    }
  });

  test.each(["removal", "replacement"])(
    "updates a separately registered linked worktree after updates and metadata %s",
    async (change) => {
      const observed = new ObservedPlacements(
        [
          { id: "repo", root: "repo", workspaces: [{ id: "main-ws", cwd: "repo" }] },
          {
            id: "unrelated",
            root: "repo-other",
            workspaces: [{ id: "other-ws", cwd: "repo-other" }],
          },
        ],
        true,
      );
      try {
        await observed.start();
        observed.git("repo", "init", "-b", "main");
        observed.git(
          "repo",
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "initial",
        );
        observed.git("repo", "remote", "add", "origin", "https://github.com/acme/old.git");
        observed.git("repo", "worktree", "add", "-b", "feature", "../linked");
        await observed.add({
          id: "linked",
          root: "linked",
          workspaces: [{ id: "linked-ws", cwd: "linked" }],
        });
        observed.git("repo-other", "init", "-b", "main");
        observed.change("linked", ".git");
        await observed.advanceBy(DEBOUNCE_MS);
        expect(await observed.placement("linked-ws")).toMatchObject({ branch: "feature" });
        const oldKey = (await observed.project("linked"))?.projectKey;
        observed.takeCheckoutReads();

        observed.git("repo", "remote", "set-url", "origin", "https://github.com/acme/new.git");
        observed.git("repo", "branch", "-m", "feature", "renamed");
        observed.change("repo", ".git");
        await observed.advanceBy(DEBOUNCE_MS);

        expect(await observed.placement("linked-ws")).toMatchObject({ branch: "renamed" });
        const linkedProject = await observed.project("linked");
        expect(linkedProject?.projectKey).toEqual((await observed.project("repo"))?.projectKey);
        expect(linkedProject?.projectKey).not.toEqual(oldKey);
        expect(observed.takeCheckoutReads()).toEqual(["linked", "repo"]);
        expect(await observed.project("unrelated")).toMatchObject({ kind: "non_git" });
        expect(await observed.placement("other-ws")).toMatchObject({ kind: "directory" });

        observed.rename("repo/.git", "repo/.git-backup");
        if (change === "replacement") observed.git("repo", "init", "-b", "main");
        observed.change("repo", ".git");
        await observed.advanceBy(DEBOUNCE_MS);

        expect(await observed.project("linked")).toMatchObject({ kind: "non_git" });
        expect(await observed.placement("linked-ws")).toMatchObject({ kind: "directory" });
        expect(observed.takeCheckoutReads()).toEqual(["linked", "repo"]);
      } finally {
        await observed.disposeGit();
      }
    },
  );

  test("skips independent nested repositories and workspaces attached from other repositories", async () => {
    const observed = new ObservedPlacements(
      [
        {
          id: "outer",
          root: "outer",
          workspaces: [
            { id: "outer-ws", cwd: "outer" },
            { id: "foreign-ws", cwd: "foreign" },
          ],
        },
        {
          id: "nested",
          root: "outer/independent",
          workspaces: [
            { id: "nested-ws", cwd: "outer/independent" },
            { id: "nested-linked-ws", cwd: "independent-linked" },
          ],
        },
      ],
      true,
    );
    try {
      await observed.start();
      for (const root of ["outer", "outer/independent", "foreign"]) {
        observed.git(root, "init", "-b", "main");
      }
      observed.git(
        "outer/independent",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      );
      observed.git(
        "outer/independent",
        "worktree",
        "add",
        "-b",
        "feature",
        "../../independent-linked",
      );
      observed.change("outer", ".git");
      await observed.advanceBy(DEBOUNCE_MS);

      expect(observed.takeCheckoutReads()).toEqual(["outer"]);
      expect(await observed.placement("outer-ws")).toMatchObject({ kind: "local_checkout" });
      for (const id of ["foreign-ws", "nested-ws", "nested-linked-ws"]) {
        expect(await observed.placement(id)).toMatchObject({ kind: "directory" });
      }
    } finally {
      await observed.disposeGit();
    }
  });

  test("skips a submodule and its linked checkout when the parent Git directory is intact", async () => {
    const observed = new ObservedPlacements(
      [{ id: "outer", root: "outer", workspaces: [{ id: "outer-ws", cwd: "outer" }] }],
      true,
    );
    try {
      await observed.start();
      await observed.add({ id: "source", root: "source" });
      observed.git("source", "init", "-b", "main");
      observed.git(
        "source",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      );
      observed.git("outer", "init", "-b", "main");
      observed.git(
        "outer",
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "../source",
        "sub",
      );
      observed.git("outer/sub", "worktree", "add", "-b", "feature", "../../sub-linked");
      await observed.add({ id: "sub", root: "outer/sub" });
      await observed.add({ id: "sub-linked", root: "sub-linked" });

      observed.change("outer", ".git");
      await observed.advanceBy(DEBOUNCE_MS);

      expect(observed.takeCheckoutReads()).toEqual(["outer"]);
      observed.rename("outer/.git", "outer/.git-backup");
      observed.change("outer", ".git");
      await observed.advanceBy(DEBOUNCE_MS);

      expect(observed.takeCheckoutReads()).toEqual(["outer", "outer/sub", "sub-linked"]);
    } finally {
      await observed.disposeGit();
    }
  });

  test("turns Git changes under several roots into one read per changed root", async () => {
    const observed = new ObservedPlacements(threeProjects(1));
    await observed.start();

    for (const root of ["repo-a", "repo-c", "repo-a", "repo-c", "repo-a"]) {
      observed.change(root, ".git");
    }
    await observed.advanceBy(DEBOUNCE_MS);

    expect(observed.takeCheckoutReads()).toEqual([
      "repo-a",
      "repo-a/worktree-1",
      "repo-c",
      "repo-c/worktree-1",
    ]);
    observed.dispose();
  });

  test("a change that lands during a pass queues a pass for only that root", async () => {
    const observed = new ObservedPlacements(threeProjects(1));
    await observed.start();
    observed.makeProjectGit("project-a");
    observed.makeProjectGit("project-b");
    const firstPassRead = observed.holdNextReconciliation();
    const firstBatch = observed.waitForWorkspaceBatch();
    const secondBatch = firstBatch.then(() => observed.waitForWorkspaceBatch());

    observed.change("repo-a", ".git");
    const firstPass = observed.advanceBy(DEBOUNCE_MS);
    await firstPassRead.started;
    observed.change("repo-b", ".git");
    observed.change("repo-b", ".git");
    await observed.advanceBy(DEBOUNCE_MS);
    firstPassRead.release();
    await firstPass;
    await secondBatch;

    expect(observed.workspaceBatches).toEqual([["a1"], ["b1"]]);
    expect(observed.takeCheckoutReads()).toEqual([
      "repo-a",
      "repo-a/worktree-1",
      "repo-b",
      "repo-b/worktree-1",
    ]);
    observed.dispose();
  });

  test("keeps the changed roots of a failed pass for the next one", async () => {
    const observed = new ObservedPlacements([
      { id: "project-a", root: "repo-a", workspaces: [{ id: "a1", cwd: "repo-a" }] },
      { id: "project-b", root: "repo-b", workspaces: [{ id: "b1", cwd: "repo-b" }] },
    ]);
    await observed.start();
    observed.makeProjectGit("project-a");
    observed.failNextReconciliation(new Error("registry unavailable"));

    observed.change("repo-a", ".git");
    await observed.advanceBy(DEBOUNCE_MS);
    observed.change("repo-b", ".git");
    await observed.advanceBy(DEBOUNCE_MS);

    expect(observed.takeCheckoutReads()).toEqual(["repo-a", "repo-b"]);
    expect((await observed.placement("a1"))?.kind).toBe("local_checkout");
    observed.dispose();
  });

  test("recovers errored and temporarily unavailable watchers on the periodic pass", async () => {
    const observed = new ObservedPlacements([
      { id: "project-errored", root: "errored" },
      { id: "project-unavailable", root: "unavailable" },
    ]);
    observed.failNextWatch("unavailable");
    await observed.start();
    expect(observed.watchedRoots()).toEqual(["errored"]);

    observed.watcherFailed("errored");
    expect(observed.watchedRoots()).toEqual([]);
    await observed.advanceBy(RESCAN_INTERVAL_MS);

    expect(observed.watchedRoots()).toEqual(["errored", "unavailable"]);
    expect(observed.closedRoots()).toEqual(["errored"]);
    observed.dispose();
  });

  test("archives missing workspace directories on the periodic pass", async () => {
    const observed = new ObservedPlacements([
      {
        id: "project-one",
        root: "repo",
        workspaces: [{ id: "workspace-one", cwd: "repo/worktree-one" }],
      },
    ]);
    await observed.start();
    await observed.deleteWorkspaceDirectory("workspace-one");

    await observed.advanceBy(RESCAN_INTERVAL_MS);

    expect((await observed.placement("workspace-one"))?.archivedAt).toEqual(expect.any(String));
    expect(observed.workspaceBatches).toEqual([["workspace-one"]]);
    const archived = await observed.placement("workspace-one");
    await observed.advanceBy(RESCAN_INTERVAL_MS);
    expect(await observed.placement("workspace-one")).toEqual(archived);
    expect(observed.workspaceBatches).toEqual([["workspace-one"]]);
    observed.dispose();
  });

  test("preserves a periodic full pass queued behind metadata reconciliation", async () => {
    const observed = new ObservedPlacements([
      {
        id: "project-one",
        root: "repo",
        workspaces: [{ id: "workspace-one", cwd: "repo/worktree-one" }],
      },
    ]);
    await observed.start();
    const metadataRead = observed.holdNextReconciliation();
    observed.change("repo", ".git");
    const metadataPass = observed.advanceBy(DEBOUNCE_MS);
    await metadataRead.started;
    await observed.deleteWorkspaceDirectory("workspace-one");
    const workspaceBatch = observed.waitForWorkspaceBatch();

    await observed.advanceBy(RESCAN_INTERVAL_MS);
    metadataRead.release();
    await metadataPass;
    await workspaceBatch;

    expect((await observed.placement("workspace-one"))?.archivedAt).toEqual(expect.any(String));
    expect(observed.workspaceBatches).toEqual([["workspace-one"]]);
    observed.dispose();
  });

  test("contains a failed reconciliation and converges on the next change", async () => {
    const observed = new ObservedPlacements([
      { id: "project-one", root: "repo", workspaces: [{ id: "workspace-one", cwd: "repo" }] },
    ]);
    await observed.start();
    observed.makeProjectGit("project-one", "main");
    observed.failNextReconciliation(new Error("registry unavailable"));

    observed.change("repo", ".git");
    await observed.advanceBy(DEBOUNCE_MS);
    expect((await observed.placement("workspace-one"))?.kind).toBe("directory");

    observed.change("repo", ".git");
    await observed.advanceBy(DEBOUNCE_MS);
    expect(await observed.placement("workspace-one")).toMatchObject({
      kind: "local_checkout",
      branch: "main",
      displayName: "Durable workspace-one",
    });
    observed.dispose();
  });

  test("deduplicates direct placement and project-derived workspace fanout", async () => {
    const observed = new ObservedPlacements([
      {
        id: "project-one",
        root: "repo",
        workspaces: [
          { id: "workspace-one", cwd: "repo" },
          { id: "workspace-two", cwd: "repo/feature" },
        ],
      },
    ]);
    await observed.start();
    observed.makeProjectGit("project-one", "main");

    observed.change("repo", ".git");
    await observed.advanceBy(DEBOUNCE_MS);

    expect(observed.projectUpdates).toHaveLength(1);
    expect(observed.workspaceBatches).toEqual([["workspace-one", "workspace-two"]]);
    expect(new Set(observed.workspaceBatches[0]).size).toBe(2);
    observed.dispose();
  });

  test("disposal suppresses in-flight mutations and reconciliation fanout", async () => {
    const mutation = new ObservedPlacements([{ id: "project-one", root: "repo" }]);
    await mutation.start();
    const registryRead = mutation.holdNextRegistryRead();
    const adding = mutation.add({ id: "project-late", root: "late" });
    await registryRead.started;
    mutation.dispose();
    registryRead.release();
    await adding;
    expect(mutation.projectUpdates).toEqual([]);
    expect(mutation.watchedRoots()).toEqual([]);

    const reconciliation = new ObservedPlacements([
      { id: "project-one", root: "repo", workspaces: [{ id: "workspace-one", cwd: "repo" }] },
    ]);
    await reconciliation.start();
    reconciliation.makeProjectGit("project-one");
    const workspaceRead = reconciliation.holdNextReconciliation();
    reconciliation.change("repo", ".git");
    const advancing = reconciliation.advanceBy(DEBOUNCE_MS);
    await workspaceRead.started;
    reconciliation.dispose();
    workspaceRead.release();
    await advancing;

    expect(reconciliation.workspaceBatches).toEqual([]);
    expect(reconciliation.watchedRoots()).toEqual([]);
    expect(reconciliation.pendingTimers).toBe(0);
  });
});
