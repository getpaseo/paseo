import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCheckoutIdentity, getCheckoutStatus } from "./checkout-git.js";
import { CheckoutReadSession } from "./checkout-read-session.js";
import { writePaseoWorktreeMetadata } from "./worktree-metadata.js";
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
    const mainRepoRoot = await realpath(repoDir);
    expect(await getCheckoutIdentity(linkedDir, { paseoHome })).toMatchObject({
      currentBranch: "feature",
      mainRepoRoot,
    });
    expect(await getCheckoutIdentity(paseoWorktree.worktreePath, { paseoHome })).toMatchObject({
      isPaseoOwnedWorktree: true,
      mainRepoRoot,
    });
    expect(await getCheckoutIdentity(plainDir, { paseoHome })).toEqual({ isGit: false });
  });

  it("reads Git worktree registration once for all marked worktrees in a batch", async () => {
    const second = join(tempDir, "second");
    git(repoDir, "worktree", "add", "-b", "second", second);
    await writePaseoWorktreeMetadata(linkedDir, { baseRefName: "main" });
    await writePaseoWorktreeMetadata(second, { baseRefName: "main" });

    const readSession = new CheckoutReadSession();
    startGitCommandMetrics();
    try {
      const checkouts = await Promise.all([
        getCheckoutIdentity(linkedDir, { paseoHome, readSession }),
        getCheckoutIdentity(second, { paseoHome, readSession }),
      ]);
      expect(checkouts).toMatchObject([
        { isGit: true, currentBranch: "feature", isPaseoOwnedWorktree: true },
        { isGit: true, currentBranch: "second", isPaseoOwnedWorktree: true },
      ]);
      const worktreeLists = stopGitCommandMetrics().commands.filter(
        (command) => command.args[0] === "worktree" && command.args[1] === "list",
      );
      expect(worktreeLists).toHaveLength(1);
    } finally {
      stopGitCommandMetrics();
    }
  });

  it("shares worktree registration and main checkout discovery in a bare repository", async () => {
    const bare = join(tempDir, "shared.git");
    const main = join(tempDir, "main");
    const first = join(tempDir, "first");
    const second = join(tempDir, "second");
    git(repoDir, "clone", "--bare", repoDir, bare);
    git(bare, "worktree", "add", main, "main");
    git(bare, "worktree", "add", "-b", "first", first);
    git(bare, "worktree", "add", "-b", "second", second);
    await writePaseoWorktreeMetadata(first, { baseRefName: "main" });
    await writePaseoWorktreeMetadata(second, { baseRefName: "main" });

    const readSession = new CheckoutReadSession();
    startGitCommandMetrics();
    try {
      const checkouts = await Promise.all(
        [main, first, second].map((cwd) => getCheckoutIdentity(cwd, { paseoHome, readSession })),
      );
      const mainRepoRoot = await realpath(main);
      expect(checkouts).toMatchObject([
        { currentBranch: "main", isPaseoOwnedWorktree: false, mainRepoRoot: null },
        { currentBranch: "first", isPaseoOwnedWorktree: true },
        { currentBranch: "second", isPaseoOwnedWorktree: true },
      ]);
      for (const checkout of checkouts.slice(1)) {
        if (!checkout.isGit || !checkout.mainRepoRoot) {
          throw new Error("Expected bare worktree checkout to report mainRepoRoot");
        }
        expect(realpathSync.native(checkout.mainRepoRoot)).toBe(mainRepoRoot);
      }
      const worktreeLists = stopGitCommandMetrics().commands.filter(
        (command) => command.args[0] === "worktree" && command.args[1] === "list",
      );
      expect(worktreeLists).toHaveLength(1);
    } finally {
      stopGitCommandMetrics();
    }
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
