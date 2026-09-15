import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import type { CheckoutSnapshotFacts, CheckoutStatusGit } from "../utils/checkout-git.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { createFileObserver } from "./file-observer/index.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import type { FileChange, SubscribeToFileChanges } from "./file-observer/index.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    warn: vi.fn(),
  };
  return logger as unknown as pino.Logger;
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

function hasIgnoreUpdateCoveringPath(params: {
  updates: Array<{ directory: string; paths: string[] }>;
  directory: string;
  targetPath: string;
}): boolean {
  const { updates, directory, targetPath } = params;
  for (const update of updates) {
    if (update.directory !== directory) continue;
    for (const ignoredPath of update.paths) {
      if (path.resolve(ignoredPath) === targetPath) return true;
    }
  }
  return false;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

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
  const diffManager = new CheckoutDiffManager({
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
      expect(activeWatcherCount).toBe(2);
      expect(service.peekSnapshot(repoDir)).not.toBeNull();
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

interface LateIgnoredDirectoryHarness {
  observer: ReturnType<typeof createFileObserver>;
  repoDir: string;
  depsDir: string;
  ignoreUpdates: Array<{ directory: string; paths: string[] }>;
  deliveredEvents: Array<{ directory: string; events: FileChange[] }>;
  setDepsExists: (value: boolean) => void;
}

// Shared by both tests below: the platform-independent delivered-events test
// and the native-only tracked-file-count test need the exact same watcher,
// service, and gitignore-refresh wiring established before either one can
// assert anything. Keeping it in one place also means the "deps/ is
// gitignored but does not exist yet" fixture behavior — the real `git`
// behavior this bug depends on — is defined once.
async function setUpLateIgnoredDirectoryHarness(): Promise<LateIgnoredDirectoryHarness> {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-late-ignored-")));
  const repoDir = path.join(tempDir, "repo");
  const depsDir = path.join(repoDir, "deps");
  mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  mkdirSync(path.join(repoDir, "src"), { recursive: true });
  writeFileSync(path.join(repoDir, "src", "tracked.txt"), "base\n");

  const observer = createFileObserver();
  const ignoreUpdates: Array<{ directory: string; paths: string[] }> = [];
  const deliveredEvents: Array<{ directory: string; events: FileChange[] }> = [];
  // The delivered-events assertion reads only `deliveredEvents` /
  // `ignoreUpdates`, both of which are populated identically by every
  // backend (native-recursive on macOS/Windows, the per-directory watcher
  // model on Linux) because both funnel through `Observation.queueEvent`,
  // which applies the same `isIgnored` check regardless of backend. See the
  // report for the full argument on why this holds on Linux even though it
  // cannot be run here.
  const subscribe: SubscribeToFileChanges = async (directory, callback, options) => {
    const subscription = await observer.subscribe(
      directory,
      (error, events) => {
        deliveredEvents.push({ directory, events });
        callback(error, events);
      },
      options,
    );
    return {
      updateIgnore: async (paths: string[]) => {
        await subscription.updateIgnore(paths);
        ignoreUpdates.push({ directory, paths: [...paths] });
      },
      unsubscribe: () => subscription.unsubscribe(),
    };
  };
  const fileObserver = {
    subscribe,
    getDiagnostics: () => observer.getDiagnostics(),
    close: () => observer.close(),
  };

  // `deps/` is gitignored but does not exist yet, so `ls-files -o -i` reports
  // nothing until it exists on disk — reproducing the real `git` behavior the
  // bug depends on.
  let depsExists = false;
  // `createFacts`/`createStatus` predate the `upstreamStatus`/`upstreamRef`
  // fields on the real types and are shared with other tests in this file
  // that this PR does not otherwise touch — fill the gap here instead of
  // widening the shared fixtures, so `deps` below can carry its real type
  // instead of an `as never` bypass.
  const getCheckoutSnapshotFacts = vi.fn(async (cwd: string): Promise<CheckoutSnapshotFacts> => {
    const facts = createFacts(cwd);
    // Narrow before spreading — `createFacts` always returns the `isGit: true`
    // branch, but its declared return type is the full union, and spreading
    // `upstreamStatus` across an un-narrowed union would also (incorrectly)
    // attach it to the `isGit: false` member.
    return facts.isGit ? { ...facts, upstreamStatus: null } : facts;
  });
  const getCheckoutStatus = vi.fn(
    async (cwd: string): Promise<CheckoutStatusGit> => ({
      ...createStatus(cwd),
      upstreamRef: null,
    }),
  );
  const getCheckoutShortstat = vi.fn(async () => ({ additions: 0, deletions: 0 }));
  const getCheckoutWorktreeState = vi.fn(async () => ({
    isDirty: false,
    diffStat: { additions: 0, deletions: 0 },
  }));
  const getCheckoutDiff = vi.fn(async () => ({ diff: "", structured: [] }));
  const runGitCommand = vi.fn(async (args: string[]) => {
    if (args[0] === "rev-parse") {
      return { stdout: `${repoDir}\n`, stderr: "", truncated: false, exitCode: 0, signal: null };
    }
    if (args[0] === "ls-files") {
      return {
        stdout: depsExists ? "deps/\n" : "",
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
    },
  });
  // Let `service.dispose()` release the observer itself (it owns
  // `fileObserver.close`), instead of closing the raw `observer` separately —
  // closing it out from under the service would mask a bug in the service's
  // own unsubscribe/dispose path.
  cleanup.push(async () => {
    await service.dispose();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const subscription = service.registerWorkspace({ cwd: repoDir }, vi.fn());
  cleanup.push(async () => {
    subscription.unsubscribe();
  });

  // Confirm observation is genuinely established before trusting anything
  // below: setup must finish, the ignore query must actually have run, and a
  // snapshot must exist.
  await expect
    .poll(() => service.getMetrics().workspaceObservationSetupInFlightCount, { timeout: 20_000 })
    .toBe(0);
  expect(runGitCommand).toHaveBeenCalledWith(
    expect.arrayContaining(["ls-files"]),
    expect.anything(),
  );
  expect(service.peekSnapshot(repoDir)).not.toBeNull();

  return {
    observer,
    repoDir,
    depsDir,
    ignoreUpdates,
    deliveredEvents,
    setDepsExists: (value: boolean) => {
      depsExists = value;
    },
  };
}

// Phase 1: create the ignored directory and a small batch of files inside
// it. Under the fix, discovering an untracked directory must trigger a
// working-tree ignore refresh that ends up calling `updateIgnore` with
// `deps/` included; today nothing does. Events delivered during this phase
// are not asserted on — they are allowed to leak while the refresh is still
// in flight (see "why two phases" in the report).
async function runPhase1AndWaitForIgnore(harness: LateIgnoredDirectoryHarness): Promise<void> {
  harness.setDepsExists(true);
  mkdirSync(harness.depsDir, { recursive: true });
  for (let index = 0; index < 100; index += 1) {
    writeFileSync(path.join(harness.depsDir, `phase1-${index}.js`), `${index}\n`);
  }

  // RED today: no code path calls `updateIgnore` for a plain new directory
  // (only a `.gitignore`-named file event does), so `ignoreUpdates` never
  // gains an entry naming `deps/`, and this wait runs the full 15s and fails
  // — for exactly the reason under test, on every platform, since it depends
  // only on the `updateIgnore` call the working-tree watch target already
  // makes today (see `replaceWorkingTreeIgnoredDirectories` in
  // `workspace-git-service.ts`), not on any backend-specific diagnostics.
  await vi.waitFor(
    () => {
      expect(
        hasIgnoreUpdateCoveringPath({
          updates: harness.ignoreUpdates,
          directory: harness.repoDir,
          targetPath: harness.depsDir,
        }),
      ).toBe(true);
    },
    { timeout: 15_000 },
  );
}

// Phase 2: the ignore set already includes `deps/` at this point —
// `Observation.updateIgnore` assigns `this.ignoredRoots` synchronously before
// awaiting the backend, and that assignment happened strictly before phase
// 1's `await subscription.updateIgnore(...)` resolved, which is strictly
// before it was observed in `ignoreUpdates`, which is strictly before the
// write loop below starts. So every file created below is checked against
// the *already-updated* ignore set by `Observation.queueEvent`'s `isIgnored`
// guard the moment any backend reports it, regardless of which internal code
// path (native `classify`, an audit reconciliation, or the Linux
// per-directory watcher callback) produced the event. None of these 2,000
// new files should ever reach the subscriber callback. Returns the delivered
// event count as of just before the writes, so the caller can isolate the
// events this phase alone produced.
async function runPhase2(harness: LateIgnoredDirectoryHarness): Promise<number> {
  const deliveredBeforePhase2 = harness.deliveredEvents.length;
  for (let index = 0; index < 2_000; index += 1) {
    writeFileSync(path.join(harness.depsDir, `phase2-${index}.js`), `${index}\n`);
  }

  // Give the filesystem a generous window to deliver anything it would
  // (there is no async catch-up step to wait for on the fixed path — the
  // ignore check is synchronous at event-arrival time — so this is purely
  // margin for OS event delivery latency, not a condition we are hoping
  // resolves a particular way).
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  return deliveredBeforePhase2;
}

test("an ignored directory created after subscribe stops delivering events once ignored", async () => {
  const harness = await setUpLateIgnoredDirectoryHarness();
  await runPhase1AndWaitForIgnore(harness);
  const deliveredBeforePhase2 = await runPhase2(harness);

  const depsPrefix = `${harness.depsDir}${path.sep}`;
  const phase2EventsUnderDeps = harness.deliveredEvents
    .slice(deliveredBeforePhase2)
    .flatMap((batch) => batch.events)
    .filter((event) => {
      const resolved = path.resolve(event.path);
      return resolved === harness.depsDir || resolved.startsWith(depsPrefix);
    });

  expect(phase2EventsUnderDeps).toHaveLength(0);
}, 40_000);

// `nativeTrackedFileCount` is meaningful evidence of a live watch on the
// backends that populate it, but the Linux backend
// (`file-observer/internal/linux.ts`) hardcodes it to 0 — it has no per-file
// inventory, only a `Map` of directory watchers. Skipped as a whole there
// instead of gated inline, so every run of this test proves the same thing;
// the platform-independent delivered-events coverage lives in the test
// above, which runs everywhere.
test.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
  "an ignored directory created after subscribe keeps the native tracked-file inventory bounded",
  async () => {
    const harness = await setUpLateIgnoredDirectoryHarness();
    expect(harness.observer.getDiagnostics().nativeTrackedFileCount).toBeGreaterThan(0);

    await runPhase1AndWaitForIgnore(harness);
    await runPhase2(harness);

    // The backend's own inventory should not have absorbed the phase-2 files
    // either.
    expect(harness.observer.getDiagnostics().nativeTrackedFileCount).toBeLessThan(300);
  },
  40_000,
);
