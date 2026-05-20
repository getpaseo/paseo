#!/usr/bin/env npx tsx

import assert from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  findManagedWorktreeByNameOrBranch,
  parseGitWorktreeList,
  resolvePaseoHomePath,
  resolvePaseoWorktreesDir,
} from "../src/commands/worktree/ls.js";

console.log("=== Worktree LS Path Helper Tests ===\n");

const originalPaseoHome = process.env.PASEO_HOME;

try {
  {
    console.log("Test 1: resolves explicit PASEO_HOME when set");
    process.env.PASEO_HOME = "/tmp/paseo-explicit-home";

    assert.strictEqual(resolvePaseoHomePath(), "/tmp/paseo-explicit-home");
    assert.strictEqual(resolvePaseoWorktreesDir(), "/tmp/paseo-explicit-home/worktrees");
    console.log("\u2713 explicit PASEO_HOME is respected\n");
  }

  {
    console.log("Test 2: falls back to homedir/.paseo when PASEO_HOME is unset");
    delete process.env.PASEO_HOME;

    assert.strictEqual(resolvePaseoHomePath(), join(homedir(), ".paseo"));
    assert.strictEqual(resolvePaseoWorktreesDir(), join(homedir(), ".paseo", "worktrees"));
    console.log("\u2713 fallback home path is derived from os.homedir()\n");
  }

  {
    console.log("Test 3: parses git worktree porcelain output");
    const entries = parseGitWorktreeList(`worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /tmp/paseo-home/worktrees/project/feature-a
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature-a

worktree /tmp/paseo-home/worktrees/project/detached
HEAD 3333333333333333333333333333333333333333
detached
`);

    assert.deepStrictEqual(
      entries.map((entry) => ({
        worktreePath: entry.worktreePath,
        branchName: entry.branchName,
        head: entry.head,
      })),
      [
        {
          worktreePath: "/repo",
          branchName: "main",
          head: "1111111111111111111111111111111111111111",
        },
        {
          worktreePath: "/tmp/paseo-home/worktrees/project/feature-a",
          branchName: "feature-a",
          head: "2222222222222222222222222222222222222222",
        },
        {
          worktreePath: "/tmp/paseo-home/worktrees/project/detached",
          branchName: null,
          head: "3333333333333333333333333333333333333333",
        },
      ],
    );
    console.log("\u2713 git worktree porcelain output is parsed\n");
  }

  {
    console.log("Test 4: resolves worktrees by directory name or branch name");
    const entries = parseGitWorktreeList(`worktree /tmp/paseo-home/worktrees/project/feature-a
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature-a

worktree /tmp/paseo-home/worktrees/project/readable-name
HEAD 4444444444444444444444444444444444444444
branch refs/heads/feat/long-branch
`);

    assert.strictEqual(
      findManagedWorktreeByNameOrBranch(entries, "feature-a")?.worktreePath,
      "/tmp/paseo-home/worktrees/project/feature-a",
    );
    assert.strictEqual(
      findManagedWorktreeByNameOrBranch(entries, "feat/long-branch")?.worktreePath,
      "/tmp/paseo-home/worktrees/project/readable-name",
    );
    assert.strictEqual(findManagedWorktreeByNameOrBranch(entries, "missing"), null);
    console.log("\u2713 worktrees resolve by directory name or branch name\n");
  }
} finally {
  if (originalPaseoHome === undefined) {
    delete process.env.PASEO_HOME;
  } else {
    process.env.PASEO_HOME = originalPaseoHome;
  }
}

console.log("=== All worktree ls path helper tests passed ===");
