import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  isHeldByArchivedWorktree,
  readArchivedHead,
  releaseArchivedHead,
  saveArchivedHead,
} from "./archived-head.js";

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
  await saveArchivedHead({ worktreePath, repoRoot, hadActiveWorkspace: true });
  removeWorktree(repoRoot, worktreePath);

  const onBranch = await readArchivedHead({ repoRoot, worktreePath });
  git(repoRoot, ["branch", "-f", "feature", "main"]);
  const branchMoved = await readArchivedHead({ repoRoot, worktreePath });
  git(repoRoot, ["branch", "-D", "feature"]);
  const branchDeleted = await readArchivedHead({ repoRoot, worktreePath });

  expect({ onBranch, branchMoved, branchDeleted }).toEqual({
    onBranch: { checkout: "feature", commit },
    branchMoved: { checkout: commit, commit },
    branchDeleted: { checkout: commit, commit },
  });
});

test("a removed folder reached through a symlinked parent finds the HEAD saved under its real path", async () => {
  const { repoRoot, worktreePath } = createRepositoryWithWorktree();
  const linkedParent = `${dirname(worktreePath)}-link`;
  symlinkSync(dirname(worktreePath), linkedParent);
  tempDirectories.push(linkedParent);
  const linkedWorktreePath = join(linkedParent, basename(worktreePath));
  const commit = git(worktreePath, ["rev-parse", "HEAD"]);
  await saveArchivedHead({ worktreePath, repoRoot, hadActiveWorkspace: true });
  removeWorktree(repoRoot, worktreePath);

  expect({
    held: await isHeldByArchivedWorktree({ repoRoot, worktreePath: linkedWorktreePath }),
    head: await readArchivedHead({ repoRoot, worktreePath: linkedWorktreePath }),
  }).toEqual({ held: true, head: { checkout: "feature", commit } });
});

test("a HEAD left behind by a failed release is not read as current after the folder disappears", async () => {
  const { repoRoot, worktreePath } = createRepositoryWithWorktree();
  // An earlier archive saved HEAD, and the unarchive that followed could not delete it.
  await saveArchivedHead({ worktreePath, repoRoot, hadActiveWorkspace: true });
  git(worktreePath, ["commit", "--allow-empty", "-m", "work after unarchive"]);
  // The folder disappears outside Paseo, then the active workspace is archived.
  removeWorktree(repoRoot, worktreePath);
  await saveArchivedHead({ worktreePath, repoRoot, hadActiveWorkspace: true });

  expect(await readArchivedHead({ repoRoot, worktreePath })).toBeNull();
});

test("archiving workspaces that were already archived keeps the HEAD saved when the folder went", async () => {
  const { repoRoot, worktreePath } = createRepositoryWithWorktree();
  const commit = git(worktreePath, ["rev-parse", "HEAD"]);
  await saveArchivedHead({ worktreePath, repoRoot, hadActiveWorkspace: true });
  removeWorktree(repoRoot, worktreePath);
  await saveArchivedHead({ worktreePath, repoRoot, hadActiveWorkspace: false });

  expect(await readArchivedHead({ repoRoot, worktreePath })).toEqual({
    checkout: "feature",
    commit,
  });
});

test("saving again replaces the HEAD saved before, whatever git named it", async () => {
  const { repoRoot, worktreePath } = createRepositoryWithWorktree();
  await saveArchivedHead({ worktreePath, repoRoot, hadActiveWorkspace: true });
  // The next name sits below the saved one, which git cannot hold beside it.
  git(worktreePath, ["checkout", "-b", "other"]);
  git(worktreePath, ["branch", "-D", "feature"]);
  git(worktreePath, ["checkout", "-b", "feature/next"]);
  git(worktreePath, ["checkout", "--detach"]);
  const detached = git(worktreePath, ["rev-parse", "HEAD"]);
  await saveArchivedHead({ worktreePath, repoRoot, hadActiveWorkspace: false });
  git(worktreePath, ["checkout", "feature/next"]);
  await saveArchivedHead({ worktreePath, repoRoot, hadActiveWorkspace: false });
  removeWorktree(repoRoot, worktreePath);

  expect({
    saved: git(repoRoot, ["for-each-ref", "--format=%(objectname)", "refs/paseo"]),
    restored: await readArchivedHead({ repoRoot, worktreePath }),
  }).toEqual({ saved: detached, restored: { checkout: "feature/next", commit: detached } });

  await releaseArchivedHead({ repoRoot, worktreePath });
  expect(git(repoRoot, ["for-each-ref", "refs/paseo"])).toBe("");
});
