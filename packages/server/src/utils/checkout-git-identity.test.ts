import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCheckoutIdentity, getCheckoutStatus } from "./checkout-git.js";
import { createWorktree } from "./worktree.js";
import { startGitCommandMetrics, stopGitCommandMetrics } from "./run-git-command.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
}

describe("getCheckoutIdentity", () => {
  let tempDir: string;
  let paseoHome: string;
  let repoDir: string;
  let linkedDir: string;
  let plainDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "checkout-identity-")));
    paseoHome = join(tempDir, "paseo-home");
    repoDir = join(tempDir, "repo");
    linkedDir = join(tempDir, "linked");
    plainDir = join(tempDir, "plain");
    mkdirSync(paseoHome);
    mkdirSync(repoDir);
    mkdirSync(plainDir);
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.email", "test@test.com");
    git(repoDir, "config", "user.name", "Test");
    writeFileSync(join(repoDir, "tracked.txt"), "tracked\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "initial");
    git(repoDir, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    git(repoDir, "worktree", "add", "-b", "feature", linkedDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports the same identity as the full status for a checkout, linked and Paseo worktrees and a plain folder", async () => {
    const paseoWorktree = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "alpha",
      source: { kind: "branch-off", baseBranch: "main", branchName: "alpha" },
      paseoHome,
    });
    for (const cwd of [repoDir, linkedDir, paseoWorktree.worktreePath]) {
      const status = await getCheckoutStatus(cwd, { paseoHome });
      const identity = await getCheckoutIdentity(cwd, { paseoHome });
      if (!status.isGit) throw new Error(`${cwd} should be a git checkout`);
      expect(identity).toEqual({
        isGit: true,
        repoRoot: status.repoRoot,
        mainRepoRoot: status.mainRepoRoot,
        currentBranch: status.currentBranch,
        remoteUrl: status.remoteUrl,
        isPaseoOwnedWorktree: status.isPaseoOwnedWorktree,
      });
    }
    expect(await getCheckoutIdentity(linkedDir, { paseoHome })).toMatchObject({
      currentBranch: "feature",
      mainRepoRoot: repoDir,
    });
    expect(await getCheckoutIdentity(paseoWorktree.worktreePath, { paseoHome })).toMatchObject({
      isPaseoOwnedWorktree: true,
      mainRepoRoot: repoDir,
    });
    expect(await getCheckoutIdentity(plainDir, { paseoHome })).toEqual({ isGit: false });
  });

  it("never scans the working tree or compares commits", async () => {
    startGitCommandMetrics();
    await getCheckoutIdentity(repoDir, { paseoHome });
    await getCheckoutIdentity(linkedDir, { paseoHome });
    const verbs = stopGitCommandMetrics().commands.map((command) => command.args[0]);

    expect(verbs.length).toBeGreaterThan(0);
    expect(
      verbs.filter((verb) => ["status", "ls-files", "rev-list", "diff"].includes(verb)),
    ).toEqual([]);
  });
});
