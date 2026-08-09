import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";

import {
  getGitCommandMetrics,
  startGitCommandMetrics,
  stopGitCommandMetrics,
  waitForGitCommandMetricsIdle,
} from "../utils/run-git-command.js";
import { fetchWorkspaceGitRemote } from "./workspace-git-fetch.js";
import {
  WorkspaceGitServiceImpl,
  getWorkspaceGitSelfHealPhaseMs,
} from "./workspace-git-service.js";

const SIBLING_COUNT = 59;
const REMOTE_REF_COUNT = 19_500;
const cleanupPaths: string[] = [];
let fixture: ReturnType<typeof seedFetchFixture>;

beforeAll(() => {
  fixture = seedFetchFixture();
}, 120_000);

afterAll(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
}, 120_000);

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function gitAsync(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function hasSubmittedGitOperation(operation: string): boolean {
  return getGitCommandMetrics().submissions.some((command) => command.args[0] === operation);
}

async function waitForCondition(
  description: string,
  condition: () => boolean,
  timeoutMs = 120_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function seedFetchFixture(): {
  originRoot: string;
  paseoHome: string;
  repoRoot: string;
  worktrees: string[];
} {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "paseo-noop-fetch-"));
  cleanupPaths.push(fixtureRoot);
  const repoRoot = join(fixtureRoot, "repo");
  const originRoot = join(fixtureRoot, "origin.git");
  const paseoHome = join(fixtureRoot, "paseo-home");
  const worktreesRoot = join(fixtureRoot, "worktrees");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(paseoHome, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });

  git(repoRoot, ["init", "-b", "main"]);
  git(repoRoot, ["config", "user.email", "repro@example.com"]);
  git(repoRoot, ["config", "user.name", "Repro"]);
  writeFileSync(join(repoRoot, "README.md"), "no-op fetch repro\n");
  git(repoRoot, ["add", "README.md"]);
  git(repoRoot, ["commit", "-m", "initial"]);

  git(fixtureRoot, ["init", "--bare", originRoot]);
  git(repoRoot, ["remote", "add", "origin", originRoot]);
  git(repoRoot, ["push", "--quiet", "-u", "origin", "main"]);

  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const remoteRefUpdates = Array.from(
    { length: REMOTE_REF_COUNT },
    (_, index) => `update refs/heads/load/${index.toString().padStart(5, "0")} ${head}`,
  ).join("\n");
  git(originRoot, ["update-ref", "--stdin"], `${remoteRefUpdates}\n`);
  git(originRoot, ["pack-refs", "--all", "--prune"]);
  git(repoRoot, ["fetch", "--quiet", "origin", "--prune"]);
  git(repoRoot, ["pack-refs", "--all", "--prune"]);

  const worktrees = Array.from({ length: SIBLING_COUNT }, (_, index) => {
    let suffix = 0;
    let branch = `sibling-${index}-${suffix}`;
    let cwd = join(worktreesRoot, branch);
    while (getWorkspaceGitSelfHealPhaseMs(cwd) < 50_000) {
      suffix += 1;
      branch = `sibling-${index}-${suffix}`;
      cwd = join(worktreesRoot, branch);
    }
    git(repoRoot, ["worktree", "add", "--quiet", "-b", branch, cwd, "HEAD"]);
    return cwd;
  });

  return { originRoot, paseoHome, repoRoot, worktrees };
}

function advanceOriginRef(originRoot: string, ref: string): void {
  git(originRoot, ["config", "user.email", "repro@example.com"]);
  git(originRoot, ["config", "user.name", "Repro"]);
  const previous = git(originRoot, ["rev-parse", ref]);
  const tree = git(originRoot, ["show", "-s", "--format=%T", previous]);
  const next = git(originRoot, ["commit-tree", tree, "-p", previous], `advance ${ref}\n`);
  git(originRoot, ["update-ref", ref, next, previous]);
}

function advanceOriginMain(originRoot: string): void {
  advanceOriginRef(originRoot, "refs/heads/main");
}

async function measureFetchScenario(
  name: string,
  beforeFetch: () => void,
  duringFetch?: () => Promise<void>,
  quietMs = 1_500,
): Promise<{
  fetchCount: number;
  gitCommands: number;
  nonRemoteRefsChanged: boolean | undefined;
  operations: Record<string, number>;
  snapshotUpdates: number;
}> {
  const fetchStarted = createDeferred<void>();
  const releaseFetch = createDeferred<void>();
  let fetchCount = 0;
  let fetchChangedNonRemoteRefs: boolean | undefined;

  const service = new WorkspaceGitServiceImpl({
    logger: pino({ level: "silent" }),
    paseoHome: fixture.paseoHome,
    deps: {
      runGitFetch: async (cwd, observer) => {
        fetchStarted.resolve();
        await releaseFetch.promise;
        const result = await fetchWorkspaceGitRemote(cwd, observer);
        fetchChangedNonRemoteRefs = result.nonRemoteRefsChanged;
        fetchCount += 1;
        return result;
      },
    },
  });
  const snapshotCounts = new Map(fixture.worktrees.map((cwd) => [cwd, 0]));
  const subscriptions = fixture.worktrees.map((cwd) =>
    service.registerWorkspace({ cwd }, () => {
      snapshotCounts.set(cwd, (snapshotCounts.get(cwd) ?? 0) + 1);
    }),
  );

  try {
    await fetchStarted.promise;
    await waitForCondition(
      "all sibling workspace snapshots to warm before the measured fetch runs",
      () =>
        [...snapshotCounts.values()].every((count) => count >= 1) &&
        service.getMetrics().repositoryWorkspaceLinkCount === SIBLING_COUNT &&
        service.getMetrics().workspaceRefreshInFlightCount === 0 &&
        service.getMetrics().workspaceRefreshQueuedCount === 0,
    );

    beforeFetch();

    const snapshotBaseline = new Map(snapshotCounts);
    const fetchCycleStartedAt = Date.now();
    startGitCommandMetrics();
    releaseFetch.resolve();
    await duringFetch?.();
    await waitForGitCommandMetricsIdle({ quietMs, timeoutMs: 120_000 });
    const postFetch = stopGitCommandMetrics();
    const snapshotUpdatesAfterFetch = [...snapshotCounts].reduce(
      (total, [cwd, count]) => total + Math.max(0, count - (snapshotBaseline.get(cwd) ?? 0)),
      0,
    );

    const operations = Object.fromEntries(
      [...Map.groupBy(postFetch.submissions, (command) => command.args[0] ?? "").entries()]
        .map(([operation, commands]) => [operation, commands.length] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    console.info(
      "[workspace-git-fetch]",
      JSON.stringify({
        scenario: name,
        siblingCount: SIBLING_COUNT,
        remoteRefCount: REMOTE_REF_COUNT,
        fetchCount,
        durationMs: Date.now() - fetchCycleStartedAt,
        gitCommands: postFetch.submitted,
        maxConcurrentGitCommands: postFetch.maxConcurrent,
        operations,
        snapshotUpdates: snapshotUpdatesAfterFetch,
      }),
    );

    return {
      fetchCount,
      gitCommands: postFetch.submitted,
      nonRemoteRefsChanged: fetchChangedNonRemoteRefs,
      operations,
      snapshotUpdates: snapshotUpdatesAfterFetch,
    };
  } finally {
    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
    service.dispose();
  }
}

async function measureExternalFetchScenario(
  name: string,
  beforeFetch: () => void,
): Promise<{
  gitCommands: number;
  operations: Record<string, number>;
  snapshotUpdates: number;
}> {
  const initialFetchCompleted = createDeferred<void>();
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ level: "silent" }),
    paseoHome: fixture.paseoHome,
    deps: {
      runGitFetch: async (cwd, observer) => {
        const result = await fetchWorkspaceGitRemote(cwd, observer);
        initialFetchCompleted.resolve();
        return result;
      },
    },
  });
  const snapshotCounts = new Map(fixture.worktrees.map((cwd) => [cwd, 0]));
  const subscriptions = fixture.worktrees.map((cwd) =>
    service.registerWorkspace({ cwd }, () => {
      snapshotCounts.set(cwd, (snapshotCounts.get(cwd) ?? 0) + 1);
    }),
  );

  try {
    await initialFetchCompleted.promise;
    await waitForCondition(
      "all sibling workspace snapshots to warm before the external fetch runs",
      () =>
        [...snapshotCounts.values()].every((count) => count >= 1) &&
        service.getMetrics().repositoryWorkspaceLinkCount === SIBLING_COUNT &&
        service.getMetrics().workspaceRefreshInFlightCount === 0 &&
        service.getMetrics().workspaceRefreshQueuedCount === 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    const snapshotBaseline = new Map(snapshotCounts);
    beforeFetch();
    const fetchCycleStartedAt = Date.now();
    startGitCommandMetrics();
    await gitAsync(fixture.repoRoot, ["fetch", "origin", "--prune"]);
    await waitForGitCommandMetricsIdle({ quietMs: 6_000, timeoutMs: 120_000 });
    const postFetch = stopGitCommandMetrics();
    const snapshotUpdates = [...snapshotCounts].reduce(
      (total, [cwd, count]) => total + Math.max(0, count - (snapshotBaseline.get(cwd) ?? 0)),
      0,
    );
    const operations = Object.fromEntries(
      [...Map.groupBy(postFetch.submissions, (command) => command.args[0] ?? "").entries()]
        .map(([operation, commands]) => [operation, commands.length] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    console.info(
      "[workspace-git-fetch]",
      JSON.stringify({
        scenario: name,
        siblingCount: SIBLING_COUNT,
        remoteRefCount: REMOTE_REF_COUNT,
        durationMs: Date.now() - fetchCycleStartedAt,
        gitCommands: postFetch.submitted,
        maxConcurrentGitCommands: postFetch.maxConcurrent,
        operations,
        snapshotUpdates,
      }),
    );
    return { gitCommands: postFetch.submitted, operations, snapshotUpdates };
  } finally {
    for (const subscription of subscriptions) subscription.unsubscribe();
    service.dispose();
  }
}

test("a no-op fetch does not refresh sibling worktrees", async () => {
  expect(await measureFetchScenario("a no-op fetch", () => {})).toEqual({
    fetchCount: 1,
    gitCommands: 3,
    nonRemoteRefsChanged: false,
    operations: { fetch: 1, "for-each-ref": 2 },
    snapshotUpdates: 0,
  });
}, 240_000);

test("an origin/main update narrowly refreshes 59 sibling worktrees", async () => {
  expect(
    await measureFetchScenario("an origin/main update", () => {
      advanceOriginMain(fixture.originRoot);
    }),
  ).toEqual({
    fetchCount: 1,
    gitCommands: 239,
    nonRemoteRefsChanged: false,
    operations: {
      diff: 59,
      fetch: 1,
      "for-each-ref": 2,
      "ls-files": 59,
      "merge-base": 59,
      "rev-list": 59,
    },
    snapshotUpdates: 59,
  });
}, 240_000);

test("an overlapping external no-op fetch stays idle", async () => {
  const result = await measureFetchScenario(
    "an overlapping external no-op fetch",
    () => {},
    () => gitAsync(fixture.repoRoot, ["fetch", "origin", "--prune"]),
    6_000,
  );
  expect(result).toEqual({
    fetchCount: 1,
    gitCommands: 3,
    nonRemoteRefsChanged: false,
    operations: { fetch: 1, "for-each-ref": 2 },
    snapshotUpdates: 0,
  });
}, 240_000);

test("an overlapping external fetch of one main update stays narrow", async () => {
  const result = await measureFetchScenario(
    "an overlapping external fetch of one main update",
    () => {
      advanceOriginMain(fixture.originRoot);
    },
    () => gitAsync(fixture.repoRoot, ["fetch", "origin", "--prune"]),
    6_000,
  );
  expect(result).toEqual({
    fetchCount: 1,
    gitCommands: 239,
    nonRemoteRefsChanged: false,
    operations: {
      diff: 59,
      fetch: 1,
      "for-each-ref": 2,
      "ls-files": 59,
      "merge-base": 59,
      "rev-list": 59,
    },
    snapshotUpdates: 59,
  });
}, 240_000);

test("an overlapping external fetch of an unrelated branch stays idle", async () => {
  const result = await measureFetchScenario(
    "an overlapping external fetch of an unrelated branch",
    () => {
      advanceOriginRef(fixture.originRoot, "refs/heads/load/00000");
    },
    () => gitAsync(fixture.repoRoot, ["fetch", "origin", "--prune"]),
    6_000,
  );
  expect(result).toEqual({
    fetchCount: 1,
    gitCommands: 3,
    nonRemoteRefsChanged: false,
    operations: { fetch: 1, "for-each-ref": 2 },
    snapshotUpdates: 0,
  });
}, 240_000);

test("a second same-ref fetch during calculation stays narrow", async () => {
  const result = await measureFetchScenario(
    "a second same-ref fetch during calculation",
    () => {
      advanceOriginMain(fixture.originRoot);
    },
    async () => {
      await waitForCondition("the first narrow calculation to start", () =>
        hasSubmittedGitOperation("rev-list"),
      );
      advanceOriginMain(fixture.originRoot);
      await gitAsync(fixture.repoRoot, ["fetch", "origin", "--prune"]);
    },
    6_000,
  );
  expect(result).toEqual({
    fetchCount: 1,
    gitCommands: 475,
    nonRemoteRefsChanged: false,
    operations: {
      diff: 118,
      fetch: 1,
      "for-each-ref": 2,
      "ls-files": 118,
      "merge-base": 118,
      "rev-list": 118,
    },
    snapshotUpdates: 118,
  });
}, 240_000);

test("a standalone external fetch of an unrelated packed branch stays idle", async () => {
  const result = await measureExternalFetchScenario(
    "a standalone external fetch of an unrelated packed branch",
    () => {
      advanceOriginRef(fixture.originRoot, "refs/heads/load/00001");
    },
  );
  expect(result).toEqual({ gitCommands: 0, operations: {}, snapshotUpdates: 0 });
}, 240_000);
