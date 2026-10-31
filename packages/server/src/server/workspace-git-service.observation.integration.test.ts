import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import type { CheckoutSnapshotFacts, CheckoutStatusGit } from "../utils/checkout-git.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { createFileObserver } from "./file-observer/index.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import type { FileChange, FileObserver, SubscribeToFileChanges } from "./file-observer/index.js";

function createLogger(): pino.Logger {
  return pino({ level: "warn" });
}

function createFacts(cwd: string): CheckoutSnapshotFacts {
  return {
    isGit: true,
    worktreeRoot: cwd,
    currentBranch: "main",
    remoteUrl: null,
    absoluteGitDir: path.join(cwd, ".git"),
    gitCommonDir: path.join(cwd, ".git"),
    paseoWorktree: { isPaseoOwnedWorktree: false },
    storedBaseRef: null,
    resolvedBaseRef: "main",
    mainRepoRoot: null,
    comparisonBaseRef: null,
    branchRemoteName: null,
    branchMergeRef: null,
    pullRequestLookupTarget: { headRef: "main" },
  };
}

function createStatus(cwd: string): CheckoutStatusGit {
  return {
    isGit: true,
    repoRoot: cwd,
    mainRepoRoot: null,
    currentBranch: "main",
    isDirty: false,
    baseRef: "main",
    aheadBehind: { ahead: 0, behind: 0 },
    aheadOfOrigin: null,
    behindOfOrigin: null,
    hasRemote: false,
    remoteUrl: null,
    isPaseoOwnedWorktree: false,
  };
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

test("a fresh checkout read makes a newly initialized repository available to cached readers", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-checkout-init-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    paseoHome: path.join(root, "home"),
  });
  cleanup.push(async () => {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  expect((await service.getSnapshot(repo, { includeForge: false })).git.isGit).toBe(false);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });

  expect((await service.getCheckout(repo)).isGit).toBe(true);
  const repoRoot = await service.resolveRepoRoot(repo);
  expect(realpathSync.native(repoRoot)).toBe(realpathSync.native(repo));
}, 30_000);

test("recursive observation updates tracked state and prunes ignored storms", async () => {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-git-observation-")));
  const repoDir = path.join(tempDir, "repo");
  const trackedPath = path.join(repoDir, "src", "tracked.txt");
  const ignoredDir = path.join(repoDir, "build");
  const remainingIgnoredDir = path.join(repoDir, "cache");
  const newlyTrackedPath = path.join(ignoredDir, "tracked.txt");
  mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  mkdirSync(path.dirname(trackedPath), { recursive: true });
  mkdirSync(ignoredDir, { recursive: true });
  mkdirSync(remainingIgnoredDir, { recursive: true });
  writeFileSync(trackedPath, "base\n");
  writeFileSync(newlyTrackedPath, "base\n");

  let activeWatcherCount = 0;
  const observer = createFileObserver();
  let watcherStartCount = 0;
  let onWorkingTreeIgnoreUpdated: (() => void) | null = null;
  const deliveredEvents: Array<{
    directory: string;
    events: FileChange[];
  }> = [];
  const subscribe: SubscribeToFileChanges = async (directory, callback, options) => {
    const subscription = await observer.subscribe(
      directory,
      (error, events) => {
        deliveredEvents.push({ directory, events });
        callback(error, events);
      },
      options,
    );
    activeWatcherCount += 1;
    watcherStartCount += 1;
    return {
      updateIgnore: async (paths) => {
        await subscription.updateIgnore(paths);
        if (directory === repoDir) {
          const onUpdated = onWorkingTreeIgnoreUpdated;
          onWorkingTreeIgnoreUpdated = null;
          onUpdated?.();
        }
      },
      unsubscribe: async () => {
        await subscription.unsubscribe();
        activeWatcherCount -= 1;
      },
    };
  };
  const fileObserver = {
    subscribe,
    getDiagnostics: () => observer.getDiagnostics(),
    close: () => observer.close(),
  };
  let observedPath = trackedPath;
  let observedRelativePath = "src/tracked.txt";
  const readObservedState = () => {
    const contents = readFileSync(observedPath, "utf8");
    const isDirty = contents !== "base\n";
    return {
      isDirty,
      additions: isDirty ? contents.trim().split("\n").length : 0,
    };
  };
  const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createFacts(cwd));
  const getCheckoutStatus = vi.fn(async (cwd: string) => ({
    ...createStatus(cwd),
    isDirty: readObservedState().isDirty,
  }));
  const getCheckoutShortstat = vi.fn(async () => ({
    additions: readObservedState().additions,
    deletions: 0,
  }));
  const getCheckoutWorktreeState = vi.fn(async () => {
    const additions = readObservedState().additions;
    return { isDirty: true, diffStat: { additions, deletions: 0 } };
  });
  const getCheckoutDiff = vi.fn(async () => {
    const additions = readObservedState().additions;
    return {
      diff: "",
      structured: [
        { path: observedRelativePath, additions, deletions: 0, status: "modified" as const },
      ],
    };
  });
  let buildIgnored = true;
  const runGitCommand = vi.fn(async (args: string[]) => {
    if (args[0] === "rev-parse") {
      return {
        stdout: `${repoDir}\n`,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      };
    }
    if (args[0] === "ls-files") {
      return {
        stdout: `${buildIgnored ? "build/\n" : ""}cache/\n`,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      };
    }
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  });
  const service = new WorkspaceGitServiceImpl({
    logger: createLogger(),
    paseoHome: path.join(tempDir, "paseo-home"),
    fileObserver,
    deps: {
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      getCheckoutShortstat,
      getCheckoutWorktreeState,
      getCheckoutDiff,
      runGitCommand,
    } as never,
  });
  const workspaceRuntimeStore = createWorkspaceRuntimeStore();
  service.onSnapshotUpdated((snapshot) => workspaceRuntimeStore.set(snapshot));
  const diffManager = new CheckoutDiffManager({
    workspaceRuntimeStore: workspaceRuntimeStore,
    logger: createLogger(),
    paseoHome: path.join(tempDir, "paseo-home"),
    workspaceGitService: service,
  });
  const summaryListener = vi.fn();
  const diffListener = vi.fn();
  const summarySubscription = service.registerWorkspace({ cwd: repoDir }, summaryListener);
  const diffSubscription = await diffManager.subscribe(
    { cwd: repoDir, compare: { mode: "uncommitted" } },
    diffListener,
  );

  cleanup.push(async () => {
    diffSubscription.unsubscribe();
    summarySubscription.unsubscribe();
    diffManager.dispose();
    await service.dispose();
    expect(activeWatcherCount).toBe(0);
    rmSync(tempDir, { recursive: true, force: true });
  });

  await vi.waitFor(
    () => {
      expect(
        activeWatcherCount,
        JSON.stringify({
          observer: observer.getDiagnostics(),
          service: service.getMetrics(),
          deliveredEvents,
        }),
      ).toBe(2);
      expect(workspaceRuntimeStore.get(repoDir)).not.toBeNull();
      expect(service.getMetrics()).toMatchObject({
        workspaceObservationSetupInFlightCount: 0,
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  writeFileSync(trackedPath, "base\n");
  await vi.waitFor(
    () => {
      const events = deliveredEvents.flatMap((batch) => batch.events);
      expect(events.map((event) => event.path)).toContain(trackedPath);
      expect(getCheckoutWorktreeState).toHaveBeenCalled();
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  getCheckoutSnapshotFacts.mockClear();
  getCheckoutStatus.mockClear();
  getCheckoutShortstat.mockClear();
  getCheckoutWorktreeState.mockClear();
  getCheckoutDiff.mockClear();
  runGitCommand.mockClear();
  deliveredEvents.length = 0;

  expect(runGitCommand).not.toHaveBeenCalled();
  expect(getCheckoutWorktreeState).not.toHaveBeenCalled();
  expect(getCheckoutDiff, JSON.stringify(deliveredEvents)).not.toHaveBeenCalled();
  expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);

  for (let index = 0; index < 100; index += 1) {
    writeFileSync(path.join(ignoredDir, `artifact-${index}.txt`), `${index}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 750));

  expect(runGitCommand).not.toHaveBeenCalled();
  expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
  expect(getCheckoutStatus).not.toHaveBeenCalled();
  expect(getCheckoutShortstat).not.toHaveBeenCalled();
  expect(getCheckoutWorktreeState).not.toHaveBeenCalled();
  expect(getCheckoutDiff).not.toHaveBeenCalled();
  expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);

  writeFileSync(trackedPath, "first\nsecond\n");
  await vi.waitFor(
    () => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 2, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: repoDir,
        files: [
          {
            path: "src/tracked.txt",
            additions: 2,
            deletions: 0,
            status: "modified",
          },
        ],
        error: null,
      });
      expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);
    },
    { timeout: 5_000 },
  );

  writeFileSync(trackedPath, "first\nsecond\nthird\n");
  await vi.waitFor(
    () => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            diffStat: { additions: 3, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          files: [expect.objectContaining({ additions: 3 })],
        }),
      );
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
  expect(getCheckoutStatus).not.toHaveBeenCalled();

  buildIgnored = false;
  observedPath = newlyTrackedPath;
  observedRelativePath = "build/tracked.txt";
  let editedDuringIgnoreUpdate = false;
  onWorkingTreeIgnoreUpdated = () => {
    editedDuringIgnoreUpdate = true;
    writeFileSync(newlyTrackedPath, "first\nsecond\n");
  };
  writeFileSync(path.join(repoDir, ".gitignore"), "cache/\n");
  await vi.waitFor(
    () => {
      expect(editedDuringIgnoreUpdate).toBe(true);
      expect(watcherStartCount).toBe(2);
      expect(activeWatcherCount).toBe(2);
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 2, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: repoDir,
        files: [
          {
            path: "build/tracked.txt",
            additions: 2,
            deletions: 0,
            status: "modified",
          },
        ],
        error: null,
      });
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 8_000 },
  );

  getCheckoutSnapshotFacts.mockClear();
  getCheckoutStatus.mockClear();
  getCheckoutShortstat.mockClear();
  getCheckoutWorktreeState.mockClear();
  getCheckoutDiff.mockClear();
  runGitCommand.mockClear();
  summaryListener.mockClear();
  diffListener.mockClear();

  writeFileSync(newlyTrackedPath, "first\nsecond\nthird\nfourth\n");
  await vi.waitFor(
    () => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 4, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: repoDir,
        files: [
          {
            path: "build/tracked.txt",
            additions: 4,
            deletions: 0,
            status: "modified",
          },
        ],
        error: null,
      });
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  getCheckoutSnapshotFacts.mockClear();
  getCheckoutStatus.mockClear();
  getCheckoutShortstat.mockClear();
  getCheckoutWorktreeState.mockClear();
  getCheckoutDiff.mockClear();
  runGitCommand.mockClear();

  for (let index = 0; index < 100; index += 1) {
    writeFileSync(path.join(remainingIgnoredDir, `artifact-${index}.txt`), `${index}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 750));

  expect(runGitCommand).not.toHaveBeenCalled();
  expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
  expect(getCheckoutStatus).not.toHaveBeenCalled();
  expect(getCheckoutShortstat).not.toHaveBeenCalled();
  expect(getCheckoutWorktreeState).not.toHaveBeenCalled();
  expect(getCheckoutDiff).not.toHaveBeenCalled();
  expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);
}, 30_000);

test("a late Git-ignored tree is pruned while tracked changes still notify consumers", async () => {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-real-ignore-")));
  const repoDir = path.join(tempDir, "repo");
  mkdirSync(repoDir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n");
  const trackedPath = path.join(repoDir, "tracked.txt");
  writeFileSync(trackedPath, "before\n");
  git("add", ".gitignore", "tracked.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "fixture");

  const observer = createFileObserver();
  const ignoredDir = path.join(repoDir, "node_modules");
  const completedIgnoreUpdates: string[][] = [];
  let notifications = 0;
  let expectTrackedEdit = false;
  let trackedBatchReachedConsumer = false;
  // Observe the real subscription without replacing Git, filesystem, or watcher behavior.
  const fileObserver: FileObserver = {
    subscribe: async (directory, callback, options) => {
      const realSubscription = await observer.subscribe(
        directory,
        (error, events) => {
          const includesTrackedEdit =
            expectTrackedEdit && events.some((e) => e.path === trackedPath);
          const before = notifications;
          callback(error, events);
          if (includesTrackedEdit && notifications > before) trackedBatchReachedConsumer = true;
        },
        options,
      );
      return {
        updateIgnore: async (paths) => {
          await realSubscription.updateIgnore(paths);
          completedIgnoreUpdates.push([...paths]);
        },
        unsubscribe: () => realSubscription.unsubscribe(),
      };
    },
    getDiagnostics: () => observer.getDiagnostics(),
    close: () => observer.close(),
  };
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    paseoHome: path.join(tempDir, "home"),
    fileObserver,
  });
  let subscription: Awaited<ReturnType<typeof service.requestWorkingTreeWatch>> | undefined;
  try {
    subscription = await service.requestWorkingTreeWatch(repoDir, () => {
      notifications += 1;
    });
    for (let index = 0; index < 20; index += 1) {
      const directory = path.join(ignoredDir, `dependency-${index}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "index.js"), "first");
    }
    expect(git("ls-files", "-o", "-i", "--directory", "--exclude-standard")).toBe("node_modules/");
    await expect
      .poll(() => completedIgnoreUpdates.some((paths) => paths.includes(ignoredDir)), {
        timeout: 5_000,
      })
      .toBe(true);

    const atIgnoreBoundary = observer.getDiagnostics();
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(path.join(ignoredDir, `dependency-${index}`, "second.js"), "second");
    }
    expectTrackedEdit = true;
    writeFileSync(trackedPath, "after\n");
    await expect.poll(() => trackedBatchReachedConsumer, { timeout: 5_000 }).toBe(true);
    const afterTrackedEdit = observer.getDiagnostics();
    expect(afterTrackedEdit.nativeHandleCount).toBe(atIgnoreBoundary.nativeHandleCount);
    expect(afterTrackedEdit.nativeTrackedFileCount).toBe(atIgnoreBoundary.nativeTrackedFileCount);
    expect(
      afterTrackedEdit.nativeClassificationCount - atIgnoreBoundary.nativeClassificationCount,
    ).toBeLessThanOrEqual(1);
  } finally {
    subscription?.unsubscribe();
    await service.dispose();
    await observer.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}, 15_000);

test("Git refresh, command tracing and 10,000 ignored alias events do no synchronous IO", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const source = `
    import assert from 'node:assert/strict';
    import { write } from 'node:fs';
    import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { setImmediate as tick } from 'node:timers/promises';
    import { createHook } from 'node:async_hooks';
    import pino from 'pino';
    import { WorkspaceGitServiceImpl } from './packages/server/src/server/workspace-git-service.ts';
    import { runGitCommand } from './packages/server/src/utils/run-git-command.ts';
    import { writePaseoWorktreeMetadata } from './packages/server/src/utils/worktree-metadata.ts';
    const root = await mkdtemp(join(tmpdir(), 'git-async-contract-'));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    const worktree = join(home, 'worktrees', 'project', 'topic');
    const alias = join(root, 'alias');
    const logger = pino({ level: 'trace' }, { write() {} });
    // Async descriptor writes avoid Windows stderr's synchronous stream API.
    const marker = (label) => new Promise((resolve, reject) => {
      write(2, label + '\\n', (error) => error ? reject(error) : resolve());
    });
    let callback;
    let notifications = 0;
    const service = new WorkspaceGitServiceImpl({ logger, paseoHome: home, deps: {
      subscribe: async (_root, onChange) => {
        callback = onChange;
        return { updateIgnore: async () => {}, unsubscribe: async () => {} };
      }
    } });
    try {
      await mkdir(repo);
      await runGitCommand(['init', '-b', 'main'], { cwd: repo });
      await runGitCommand(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'base'], { cwd: repo });
      await mkdir(join(home, 'worktrees', 'project'), { recursive: true });
      await runGitCommand(['worktree', 'add', '-b', 'topic', worktree], { cwd: repo });
      await writePaseoWorktreeMetadata(worktree, { baseRefName: 'main' });
      await writeFile(join(worktree, '.gitignore'), 'ignored/\\n');
      await mkdir(join(worktree, 'ignored'));
      await writeFile(join(worktree, 'ignored', 'noise'), 'noise');
      await symlink(worktree, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const subscription = await service.requestWorkingTreeWatch(alias, () => { notifications++; });
      const events = Array.from({ length: process.env.GIT_IO_TRACE ? 2 : 10000 }, (_, i) => ({ type: 'update', path: join(i % 2 ? alias : worktree, 'ignored', 'noise') }));
      let fsCalls = 0;
      const hook = createHook({ init(_id, type) { if (type.startsWith('FSREQ')) fsCalls++; } });
      // Collect repository setup and event-fixture garbage before measuring
      // the cold filter. Allocations made by the filter still count.
      global.gc();
      await tick();
      // Unrelated callbacks must not consume the synchronous filter's budget.
      const threadCpuUsage = Reflect.get(process, 'threadCpuUsage');
      const unrelatedWork = tick().then(() => {
        const started = threadCpuUsage();
        while (true) {
          const cpu = threadCpuUsage(started);
          if (cpu.user + cpu.system >= 80000) break;
        }
      });
      await marker('FILTER_START');
      hook.enable();
      let blockingMs;
      try {
        // This callback is synchronous: measure its own span, without waiting
        // for marker IO, loader messages or other event-loop callbacks.
        const startedAt = performance.now();
        const startedCpu = threadCpuUsage();
        callback(null, events);
        const cpu = threadCpuUsage(startedCpu);
        // Cap coarse Windows CPU accounting by elapsed time; exclude descheduling.
        blockingMs = Math.min(performance.now() - startedAt, (cpu.user + cpu.system) / 1000);
      } finally {
        hook.disable();
        await marker('FILTER_END');
      }
      await unrelatedWork;
      assert.equal(fsCalls, 0, "filesystem calls");
      assert.equal(notifications, 0, "ignored event notification");
      assert.ok(blockingMs < 20, 'blocking filter work: ' + blockingMs);
      console.log(JSON.stringify({ blockingMs, fsCalls }));
      // Alias identity remains useful after deletion: no per-event realpath can recover this file.
      callback(null, [{ type: 'delete', path: join(worktree, 'tracked.txt') }]);
      assert.equal(notifications, 1);
      await marker('REFRESH_START');
      const snapshot = await service.getSnapshot(worktree);
      assert.equal(snapshot.git.isGit, true);
      assert.equal(snapshot.git.isPaseoOwnedWorktree, true);
      await runGitCommand(['status', '--porcelain'], { cwd: alias, logger });
      await marker('REFRESH_END');
      subscription.unsubscribe();
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  `;
  for (const tracing of [false, true]) {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        ...(tracing ? ["--trace-sync-io"] : []),
        "--input-type=module",
        "--eval",
        source,
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, GIT_IO_TRACE: tracing ? "1" : "" },
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ).catch((error) => {
      throw new Error(String(error.stderr).replaceAll(/at .*/g, "[child stack omitted]"));
    });
    for (const phase of ["FILTER", "REFRESH"]) {
      const output = stderr.split(`${phase}_START\n`)[1]?.split(`${phase}_END\n`)[0];
      expect(output, `${phase}: synchronous filesystem IO`).toBe("");
    }
    const measurement = JSON.parse(stdout.trim().split("\n")[0]);
    console.info("Git filter budget", { tracing, ...measurement });
    expect(measurement).toMatchObject({ fsCalls: 0 });
  }
}, 60_000);

test("Git event identity preserves Windows namespace, case and subtree boundaries", async () => {
  const { GitObservationPaths } = await import("./git-observation-paths.js");
  const paths = await GitObservationPaths.create("C:\\paseo-observation-contract");
  const accept = paths.createEventFilter(["C:\\paseo-observation-contract\\Build"]);
  expect(paths.relative("\\\\?\\C:\\PASEO-OBSERVATION-CONTRACT\\refs\\heads\\MixedCase")).toBe(
    "refs/heads/MixedCase",
  );
  expect(accept("\\\\?\\C:\\paseo-observation-contract\\build\\noise")).toBe(false);
  expect(accept("C:\\paseo-observation-contract\\BuildSibling\\file")).toBe(true);
});

test("concurrent alias requests establish one working-tree subscription", async () => {
  const { symlink } = await import("node:fs/promises");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "git-observation-concurrent-")));
  const repo = path.join(root, "repo");
  const alias = path.join(root, "alias");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  await symlink(repo, alias, process.platform === "win32" ? "junction" : "dir");
  let subscriptions = 0;
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    paseoHome: path.join(root, "home"),
    deps: {
      subscribe: async () => {
        subscriptions++;
        return { updateIgnore: async () => {}, unsubscribe: async () => {} };
      },
    },
  });
  try {
    const watches = await Promise.all([
      service.requestWorkingTreeWatch(repo, () => {}),
      service.requestWorkingTreeWatch(alias, () => {}),
    ]);
    expect(subscriptions).toBe(1);
    for (const watch of watches) watch.unsubscribe();
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git event identity retains a symlink's literal target before canonicalizing its parent", async () => {
  const { mkdir, symlink } = await import("node:fs/promises");
  const { GitObservationPaths } = await import("./git-observation-paths.js");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "git-observation-literal-target-")));
  const repository = path.join(root, "repository");
  const parentAlias = path.join(root, "parent-alias");
  const workspaceAlias = path.join(root, "workspace-alias");
  const literalTarget = path.join(parentAlias, "repository");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  try {
    await mkdir(repository);
    await symlink(root, parentAlias, linkType);
    await symlink(literalTarget, workspaceAlias, linkType);
    const paths = await GitObservationPaths.create(workspaceAlias);
    const accept = paths.createEventFilter([path.join(workspaceAlias, "ignored")]);
    for (const spelling of [workspaceAlias, literalTarget, repository]) {
      expect(paths.relative(path.join(spelling, "deleted.txt"))).toBe("deleted.txt");
      expect(accept(path.join(spelling, "ignored", "deleted.txt"))).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
