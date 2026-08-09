import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";

import {
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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

function advanceOriginMain(originRoot: string): void {
  git(originRoot, ["config", "user.email", "repro@example.com"]);
  git(originRoot, ["config", "user.name", "Repro"]);
  const previous = git(originRoot, ["rev-parse", "refs/heads/main"]);
  const tree = git(originRoot, ["show", "-s", "--format=%T", previous]);
  const next = git(originRoot, ["commit-tree", tree, "-p", previous], "advance origin/main\n");
  git(originRoot, ["update-ref", "refs/heads/main", next, previous]);
}

test.each([
  {
    advanceMain: false,
    expectedGitCommands: 3,
    expectedSnapshotUpdates: 0,
    name: "a no-op fetch",
  },
  {
    advanceMain: true,
    expectedGitCommands: 239,
    expectedSnapshotUpdates: 59,
    name: "an origin/main update",
  },
])(
  "$name routes refreshes across 59 sibling worktrees",
  async ({ advanceMain, expectedGitCommands, expectedSnapshotUpdates, name }) => {
    const fetchStarted = createDeferred<void>();
    const releaseFetch = createDeferred<void>();
    let fetchCount = 0;
    let fetchChangedNonRemoteRefs: boolean | undefined;

    const service = new WorkspaceGitServiceImpl({
      logger: pino({ level: "silent" }),
      paseoHome: fixture.paseoHome,
      deps: {
        runGitFetch: async (cwd) => {
          fetchStarted.resolve();
          await releaseFetch.promise;
          const result = await fetchWorkspaceGitRemote(cwd);
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

      if (advanceMain) {
        advanceOriginMain(fixture.originRoot);
      }

      const snapshotBaseline = new Map(snapshotCounts);
      const fetchCycleStartedAt = Date.now();
      startGitCommandMetrics();
      releaseFetch.resolve();
      await waitForGitCommandMetricsIdle({ quietMs: 1_500, timeoutMs: 120_000 });
      const postFetch = stopGitCommandMetrics();
      const snapshotUpdatesAfterFetch = [...snapshotCounts].reduce(
        (total, [cwd, count]) => total + Math.max(0, count - (snapshotBaseline.get(cwd) ?? 0)),
        0,
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
          operations: Object.fromEntries(
            [...Map.groupBy(postFetch.submissions, (command) => command.args[0] ?? "").entries()]
              .map(([operation, commands]) => [operation, commands.length] as const)
              .sort(([left], [right]) => left.localeCompare(right)),
          ),
          snapshotUpdates: snapshotUpdatesAfterFetch,
        }),
      );

      expect(fetchCount).toBe(1);
      expect(fetchChangedNonRemoteRefs).toBe(false);
      expect(postFetch.submitted).toBe(expectedGitCommands);
      expect(snapshotUpdatesAfterFetch).toBe(expectedSnapshotUpdates);
      if (!advanceMain) {
        expect(postFetch.submissions.map((command) => command.args[0]).sort()).toEqual([
          "fetch",
          "for-each-ref",
          "for-each-ref",
        ]);
      }
    } finally {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
      service.dispose();
    }
  },
  240_000,
);
