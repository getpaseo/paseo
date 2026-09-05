import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getCheckoutStatus } from "./checkout-git.js";
import { createWorktree } from "./worktree.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, content: string): string {
  writeFileSync(join(cwd, "file.txt"), content);
  git(["add", "-A"], cwd);
  git(["commit", "-m", content], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}

function configureIdentity(cwd: string): void {
  git(["config", "user.email", "test@test.com"], cwd);
  git(["config", "user.name", "Test"], cwd);
}

describe("createWorktree branch-off base freshness", () => {
  let tempDir: string;
  let paseoHome: string;
  let originDir: string;
  /** The user's checkout: it is the one that falls behind. */
  let localDir: string;
  /** A second clone standing in for whoever pushed while the user was away. */
  let teammateDir: string;
  let staleHead: string;
  let freshHead: string;

  beforeEach(() => {
    tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), "worktree-fetch-base-")));
    paseoHome = join(tempDir, "paseo-home");
    mkdirSync(paseoHome, { recursive: true });

    originDir = join(tempDir, "origin.git");
    git(["init", "-q", "--bare", "-b", "main", originDir], tempDir);

    const seedDir = join(tempDir, "seed");
    git(["clone", "-q", originDir, seedDir], tempDir);
    configureIdentity(seedDir);
    staleHead = commit(seedDir, "one");
    git(["push", "-q", "origin", "main"], seedDir);

    // The user clones at "one" and then stops fetching.
    localDir = join(tempDir, "local");
    git(["clone", "-q", originDir, localDir], tempDir);
    configureIdentity(localDir);

    // Someone else pushes "two". The user's origin/main and main are now stale.
    teammateDir = join(tempDir, "teammate");
    git(["clone", "-q", originDir, teammateDir], tempDir);
    configureIdentity(teammateDir);
    freshHead = commit(teammateDir, "two");
    git(["push", "-q", "origin", "main"], teammateDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("starts the worktree at the newest pushed commit", async () => {
    expect(git(["rev-parse", "refs/remotes/origin/main"], localDir)).toBe(staleHead);

    const worktree = await createWorktree({
      cwd: localDir,
      worktreeSlug: "fresh",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feature/fresh" },
      runSetup: false,
      paseoHome,
    });

    expect(git(["rev-parse", "HEAD"], worktree.worktreePath)).toBe(freshHead);
    // The point of the whole feature: no commit on the remote is missing from the
    // history the agent is about to work on.
    expect(
      git(["rev-list", "--count", "HEAD..refs/remotes/origin/main"], worktree.worktreePath),
    ).toBe("0");
  });

  it("records the base it actually used, so the diff compares against fresh history", async () => {
    const worktree = await createWorktree({
      cwd: localDir,
      worktreeSlug: "recorded",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feature/recorded" },
      runSetup: false,
      paseoHome,
    });

    // Opting out pins the comparison to the stale local ref, which is why a stale
    // worktree reads as 0/0 and its staleness never surfaces anywhere in the UI.
    const status = await getCheckoutStatus(worktree.worktreePath, { paseoHome });
    expect(status.isGit).toBe(true);
    expect(status.aheadBehind).toEqual({ ahead: 0, behind: 0 });
    expect(git(["rev-parse", "HEAD"], worktree.worktreePath)).toBe(freshHead);
  });

  it("leaves the user's checkout and its branches untouched", async () => {
    const localMainBefore = git(["rev-parse", "refs/heads/main"], localDir);

    await createWorktree({
      cwd: localDir,
      worktreeSlug: "untouched",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feature/untouched" },
      runSetup: false,
      paseoHome,
    });

    expect(git(["rev-parse", "refs/heads/main"], localDir)).toBe(localMainBefore);
    expect(git(["status", "--porcelain"], localDir)).toBe("");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], localDir)).toBe("main");
  });

  it("stays on the stale local base when the caller opts out", async () => {
    const worktree = await createWorktree({
      cwd: localDir,
      worktreeSlug: "opted-out",
      source: {
        kind: "branch-off",
        baseBranch: "main",
        branchName: "feature/opted-out",
        fetchBase: false,
      },
      runSetup: false,
      paseoHome,
    });

    expect(git(["rev-parse", "HEAD"], worktree.worktreePath)).toBe(staleHead);
    expect(git(["rev-parse", "refs/remotes/origin/main"], localDir)).toBe(staleHead);
  });

  it("keeps unpushed local commits instead of branching off the remote tip", async () => {
    // The local branch is now ahead and behind: taking origin/main would drop "local-only".
    const divergedHead = commit(localDir, "local-only");

    const worktree = await createWorktree({
      cwd: localDir,
      worktreeSlug: "diverged",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feature/diverged" },
      runSetup: false,
      paseoHome,
    });

    expect(git(["rev-parse", "HEAD"], worktree.worktreePath)).toBe(divergedHead);
  });

  it("still creates the workspace when the remote is unreachable", async () => {
    git(["remote", "set-url", "origin", join(tempDir, "does-not-exist.git")], localDir);

    const worktree = await createWorktree({
      cwd: localDir,
      worktreeSlug: "offline",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feature/offline" },
      runSetup: false,
      paseoHome,
    });

    expect(git(["rev-parse", "HEAD"], worktree.worktreePath)).toBe(staleHead);
  });

  it("fetches the branch named by an explicitly qualified remote-tracking base", async () => {
    const worktree = await createWorktree({
      cwd: localDir,
      worktreeSlug: "qualified",
      source: {
        kind: "branch-off",
        baseBranch: "refs/remotes/origin/main",
        branchName: "feature/qualified",
      },
      runSetup: false,
      paseoHome,
    });

    expect(git(["rev-parse", "HEAD"], worktree.worktreePath)).toBe(freshHead);
  });
});
