import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { readArchivedHead, releaseArchivedHead, saveArchivedHead } from "./archived-head.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e.com", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function createRepositoryWithWorktree() {
  const tempDir = mkdtempSync(join(tmpdir(), "paseo-archived-head-"));
  tempDirectories.push(tempDir);
  const repoRoot = join(tempDir, "repo");
  const worktreePath = join(tempDir, "worktree");
  git(tempDir, ["init", "-b", "main", repoRoot]);
  git(repoRoot, ["commit", "--allow-empty", "-m", "base"]);
  git(repoRoot, ["worktree", "add", "-b", "feature", worktreePath]);
  git(worktreePath, ["commit", "--allow-empty", "-m", "feature work"]);
  return { repoRoot, worktreePath };
}

function removeWorktree(repoRoot: string, worktreePath: string): void {
  git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
}

test("restore checks out the saved branch while it still points at the saved commit, and the commit otherwise", async () => {
  const { repoRoot, worktreePath } = createRepositoryWithWorktree();
  const commit = git(worktreePath, ["rev-parse", "HEAD"]);
  await saveArchivedHead({ worktreePath, workspaceIds: ["wks_a"] });
  removeWorktree(repoRoot, worktreePath);

  const onBranch = await readArchivedHead({ repoRoot, workspaceId: "wks_a" });
  git(repoRoot, ["branch", "-f", "feature", "main"]);
  const branchMoved = await readArchivedHead({ repoRoot, workspaceId: "wks_a" });
  git(repoRoot, ["branch", "-D", "feature"]);
  const branchDeleted = await readArchivedHead({ repoRoot, workspaceId: "wks_a" });

  expect({ onBranch, branchMoved, branchDeleted }).toEqual({
    onBranch: { checkout: "feature", commit },
    branchMoved: { checkout: commit, commit },
    branchDeleted: { checkout: commit, commit },
  });
});

test("each workspace on the folder keeps its own saved HEAD until it is released", async () => {
  const { repoRoot, worktreePath } = createRepositoryWithWorktree();
  const commit = git(worktreePath, ["rev-parse", "HEAD"]);
  // Before v0.1.95 a workspace ID was its path, which git rejects in a ref name.
  const pathShapedId = "/home/u/.paseo/worktrees/repo/feature";
  await saveArchivedHead({ worktreePath, workspaceIds: ["wks_root", pathShapedId] });
  removeWorktree(repoRoot, worktreePath);

  await releaseArchivedHead({ repoRoot, workspaceId: "wks_root" });

  expect({
    released: await readArchivedHead({ repoRoot, workspaceId: "wks_root" }),
    kept: await readArchivedHead({ repoRoot, workspaceId: pathShapedId }),
    never: await readArchivedHead({ repoRoot, workspaceId: "wks_other" }),
  }).toEqual({ released: null, kept: { checkout: "feature", commit }, never: null });
  await releaseArchivedHead({ repoRoot, workspaceId: pathShapedId });
  expect(git(repoRoot, ["for-each-ref", "refs/paseo"])).toBe("");
});

test("archiving again once the folder is gone keeps the HEAD saved before", async () => {
  const { repoRoot, worktreePath } = createRepositoryWithWorktree();
  const commit = git(worktreePath, ["rev-parse", "HEAD"]);
  await saveArchivedHead({ worktreePath, workspaceIds: ["wks_a"] });
  removeWorktree(repoRoot, worktreePath);
  await saveArchivedHead({ worktreePath, workspaceIds: ["wks_a"] });

  expect(await readArchivedHead({ repoRoot, workspaceId: "wks_a" })).toEqual({
    checkout: "feature",
    commit,
  });
});

test("saving again replaces the HEAD saved before, whatever git named it", async () => {
  const { repoRoot, worktreePath } = createRepositoryWithWorktree();
  await saveArchivedHead({ worktreePath, workspaceIds: ["wks_a"] });
  // The next name sits below the saved one, which git cannot hold beside it.
  git(worktreePath, ["checkout", "-b", "other"]);
  git(worktreePath, ["branch", "-D", "feature"]);
  git(worktreePath, ["checkout", "-b", "feature/next"]);
  git(worktreePath, ["checkout", "--detach"]);
  const detached = git(worktreePath, ["rev-parse", "HEAD"]);
  await saveArchivedHead({ worktreePath, workspaceIds: ["wks_a"] });
  git(worktreePath, ["checkout", "feature/next"]);
  await saveArchivedHead({ worktreePath, workspaceIds: ["wks_a"] });
  removeWorktree(repoRoot, worktreePath);

  expect({
    saved: git(repoRoot, ["for-each-ref", "--format=%(objectname)", "refs/paseo"]),
    restored: await readArchivedHead({ repoRoot, workspaceId: "wks_a" }),
  }).toEqual({ saved: detached, restored: { checkout: "feature/next", commit: detached } });
});
