import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";
import { type CheckoutSnapshotFacts, getCheckoutRefDerivedState } from "./checkout-git.js";
import {
  startGitCommandMetrics,
  stopGitCommandMetrics,
  waitForGitCommandMetricsIdle,
} from "./run-git-command.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

function seedFeatureCheckout(): {
  cwd: string;
  facts: Extract<CheckoutSnapshotFacts, { isGit: true }>;
} {
  const cwd = mkdtempSync(join(tmpdir(), "paseo-ref-derived-"));
  cleanupPaths.push(cwd);
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "repro@example.com"]);
  git(cwd, ["config", "user.name", "Repro"]);
  writeFileSync(join(cwd, "base.txt"), "base\n");
  git(cwd, ["add", "base.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  const base = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["update-ref", "refs/remotes/origin/main", base]);
  git(cwd, ["switch", "--quiet", "-c", "feature"]);
  writeFileSync(join(cwd, "feature.txt"), "feature\n");
  git(cwd, ["add", "feature.txt"]);
  git(cwd, ["commit", "-m", "feature"]);

  return {
    cwd,
    facts: {
      isGit: true,
      worktreeRoot: cwd,
      currentBranch: "feature",
      remoteUrl: "https://example.com/repo.git",
      absoluteGitDir: join(cwd, ".git"),
      gitCommonDir: join(cwd, ".git"),
      paseoWorktree: { isPaseoOwnedWorktree: false },
      storedBaseRef: null,
      resolvedBaseRef: "main",
      mainRepoRoot: null,
      comparisonBaseRef: "origin/main",
      branchRemoteName: "origin",
      branchMergeRef: "refs/heads/main",
      upstreamStatus: {
        ref: "refs/remotes/origin/main",
        aheadBehind: { ahead: 0, behind: 0 },
      },
      pullRequestLookupTarget: { headRef: "feature" },
    },
  };
}

function seedMainCheckout(): {
  cwd: string;
  facts: Extract<CheckoutSnapshotFacts, { isGit: true }>;
} {
  const cwd = mkdtempSync(join(tmpdir(), "paseo-ref-derived-main-"));
  cleanupPaths.push(cwd);
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "repro@example.com"]);
  git(cwd, ["config", "user.name", "Repro"]);
  writeFileSync(join(cwd, "base.txt"), "base\n");
  git(cwd, ["add", "base.txt"]);
  git(cwd, ["commit", "-m", "base"]);
  git(cwd, ["update-ref", "refs/remotes/origin/main", git(cwd, ["rev-parse", "HEAD"])]);
  writeFileSync(join(cwd, "local.txt"), "local\n");
  git(cwd, ["add", "local.txt"]);
  git(cwd, ["commit", "-m", "local"]);

  return {
    cwd,
    facts: {
      isGit: true,
      worktreeRoot: cwd,
      currentBranch: "main",
      remoteUrl: "https://example.com/repo.git",
      absoluteGitDir: join(cwd, ".git"),
      gitCommonDir: join(cwd, ".git"),
      paseoWorktree: { isPaseoOwnedWorktree: false },
      storedBaseRef: null,
      resolvedBaseRef: "main",
      mainRepoRoot: null,
      comparisonBaseRef: null,
      branchRemoteName: "origin",
      branchMergeRef: "refs/heads/main",
      upstreamStatus: {
        ref: "refs/remotes/origin/main",
        aheadBehind: { ahead: 1, behind: 0 },
      },
      pullRequestLookupTarget: { headRef: "main" },
    },
  };
}

test("one comparison refresh updates a shared base and upstream ref", async () => {
  const { cwd, facts } = seedFeatureCheckout();
  startGitCommandMetrics();
  const result = await getCheckoutRefDerivedState(
    cwd,
    facts,
    { aheadBehind: { ahead: 0, behind: 0 }, diffStat: null },
    new Set(["origin/main"]),
  );
  await waitForGitCommandMetricsIdle({ quietMs: 50, timeoutMs: 5_000 });
  const metrics = stopGitCommandMetrics();

  expect(result.aheadBehind).toEqual({ ahead: 1, behind: 0 });
  expect(result.upstreamStatus).toEqual({
    ref: "refs/remotes/origin/main",
    aheadBehind: { ahead: 1, behind: 0 },
  });
  expect(result.diffStat).toEqual({ additions: 1, deletions: 0 });
  expect(metrics.submissions.map((command) => command.args[0]).sort()).toEqual([
    "diff",
    "ls-files",
    "merge-base",
    "rev-list",
  ]);
});

test("an upstream move refreshes the main checkout shortstat", async () => {
  const { cwd, facts } = seedMainCheckout();
  git(cwd, ["update-ref", "refs/remotes/origin/main", git(cwd, ["rev-parse", "HEAD"])]);

  const result = await getCheckoutRefDerivedState(
    cwd,
    facts,
    { aheadBehind: null, diffStat: { additions: 1, deletions: 0 } },
    new Set(["origin/main"]),
  );

  expect(result).toEqual({
    aheadBehind: null,
    diffStat: null,
    upstreamStatus: {
      ref: "refs/remotes/origin/main",
      aheadBehind: { ahead: 0, behind: 0 },
    },
  });
});
