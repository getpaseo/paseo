import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

import { createWorktree } from "./worktree.js";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "paseo-worktree-reuse-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "--initial-branch", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-m", "initial");
  return repo;
}

test("reuses the worktree of a slug instead of cutting another one beside it", async () => {
  const cwd = repository();
  const worktreesRoot = mkdtempSync(join(tmpdir(), "paseo-worktrees-"));
  const source = { kind: "branch-off" as const, branchName: "eng-42", baseBranch: "main" };

  const first = await createWorktree({
    cwd,
    worktreeSlug: "eng-42",
    source,
    runSetup: false,
    worktreesRoot,
    reuseExisting: true,
  });
  const second = await createWorktree({
    cwd,
    worktreeSlug: "eng-42",
    source,
    runSetup: false,
    worktreesRoot,
    reuseExisting: true,
  });

  // Without reuse the second call lands in `eng-42-1`, a fresh copy of `main` that knows nothing
  // of what the first one changed.
  expect(second.worktreePath).toBe(first.worktreePath);
  expect(second.branchName).toBe(first.branchName);
});
