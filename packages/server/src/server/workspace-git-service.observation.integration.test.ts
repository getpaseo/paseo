import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import parcelWatcher from "@parcel/watcher";
import type pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import type { CheckoutSnapshotFacts, CheckoutStatusGit } from "../utils/checkout-git.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import {
  subscribeToWorkspaceFileChanges,
  WorkspaceGitServiceImpl,
} from "./workspace-git-service.js";

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

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

test("native recursive observation updates tracked state and prunes ignored storms", async () => {
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
  let watcherStartCount = 0;
  let onWorkingTreeWatcherStopped: (() => void) | null = null;
  const deliveredEvents: Array<{
    directory: string;
    events: parcelWatcher.Event[];
  }> = [];
  const subscribe: typeof parcelWatcher.subscribe = async (directory, callback, options) => {
    const subscription = await subscribeToWorkspaceFileChanges(
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
      unsubscribe: async () => {
        await subscription.unsubscribe();
        activeWatcherCount -= 1;
        if (directory === repoDir) {
          const onStopped = onWorkingTreeWatcherStopped;
          onWorkingTreeWatcherStopped = null;
          onStopped?.();
        }
      },
    };
  };
  const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createFacts(cwd));
  const getCheckoutStatus = vi.fn(async (cwd: string) => createStatus(cwd));
  const getCheckoutShortstat = vi.fn(async () => ({ additions: 0, deletions: 0 }));
  let observedPath = trackedPath;
  let observedRelativePath = "src/tracked.txt";
  const getCheckoutWorktreeState = vi.fn(async () => {
    const additions = readFileSync(observedPath, "utf8").trim().split("\n").length;
    return { isDirty: true, diffStat: { additions, deletions: 0 } };
  });
  const getCheckoutDiff = vi.fn(async () => {
    const additions = readFileSync(observedPath, "utf8").trim().split("\n").length;
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
    deps: {
      subscribe,
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      getCheckoutShortstat,
      getCheckoutWorktreeState,
      getCheckoutDiff,
      runGitCommand,
      getWorkspaceGitSelfHealPhaseMs: () => 7_000,
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
    service.dispose();
    await vi.waitFor(() => expect(activeWatcherCount).toBe(0), { timeout: 5_000 });
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

  // Parcel may deliver a startup batch before subscribe resolves. Let its
  // already-scheduled consumer debounce finish inside the bootstrap phase.
  await new Promise((resolve) => setTimeout(resolve, 250));

  getCheckoutSnapshotFacts.mockClear();
  getCheckoutStatus.mockClear();
  getCheckoutShortstat.mockClear();
  getCheckoutWorktreeState.mockClear();
  getCheckoutDiff.mockClear();
  runGitCommand.mockClear();
  deliveredEvents.length = 0;

  await new Promise((resolve) => setTimeout(resolve, 250));
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
  let editedDuringWatcherHandoff = false;
  onWorkingTreeWatcherStopped = () => {
    editedDuringWatcherHandoff = true;
    writeFileSync(newlyTrackedPath, "first\nsecond\n");
  };
  writeFileSync(path.join(repoDir, ".git", "index"), "force-added\n");
  await vi.waitFor(
    () => {
      expect(editedDuringWatcherHandoff).toBe(true);
      expect(watcherStartCount).toBe(3);
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
}, 15_000);
