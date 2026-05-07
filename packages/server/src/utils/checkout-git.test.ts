import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  __resetCheckoutShortstatCacheForTests,
  __resetPullRequestStatusCacheForTests,
  __setPullRequestStatusCacheTtlForTests,
  commitAll,
  getCachedCheckoutShortstat,
  getCurrentBranch,
  getCheckoutDiff,
  getCheckoutShortstat,
  getPullRequestStatus,
  getCheckoutStatus,
  checkoutResolvedBranch,
  listBranchSuggestions,
  mergeToBase,
  mergeFromBase,
  MergeConflictError,
  MergeFromBaseConflictError,
  NotGitRepoError,
  pullCurrentBranch,
  pushCurrentBranch,
  resolveBranchCheckout,
  resolveRepositoryDefaultBranch,
  parseWorktreeList,
  isPaseoWorktreePath,
  isDescendantPath,
  warmCheckoutShortstatInBackground,
} from "./checkout-git.js";
import {
  GitHubCommandError,
  GitHubCliMissingError,
  type GitHubCurrentPullRequestStatus,
  type GitHubService,
} from "../services/github-service.js";
import {
  createWorktree as createWorktreePrimitive,
  type CreateWorktreeOptions,
  type WorktreeConfig,
} from "./worktree.js";

interface LegacyCreateWorktreeTestOptions {
  branchName: string;
  cwd: string;
  baseBranch: string;
  worktreeSlug: string;
  runSetup?: boolean;
  paseoHome?: string;
}

function createLegacyWorktreeForTest(
  options: CreateWorktreeOptions | LegacyCreateWorktreeTestOptions,
): Promise<WorktreeConfig> {
  if ("source" in options) {
    return createWorktreePrimitive(options);
  }

  return createWorktreePrimitive({
    cwd: options.cwd,
    worktreeSlug: options.worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: options.baseBranch,
      branchName: options.branchName,
    },
    runSetup: options.runSetup ?? true,
    paseoHome: options.paseoHome,
  });
}
import { getPaseoWorktreeMetadataPath } from "./worktree-metadata.js";

function initRepo(): { tempDir: string; repoDir: string } {
  const tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), "checkout-git-test-")));
  const repoDir = join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  writeFileSync(join(repoDir, "file.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], { cwd: repoDir });
  return { tempDir, repoDir };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGitHubServiceForStatus(
  status: GitHubCurrentPullRequestStatus | null,
  options?: { onStatus?: () => void },
): GitHubService {
  return {
    listPullRequests: async () => [],
    listIssues: async () => [],
    searchIssuesAndPrs: async () => ({ items: [], githubFeaturesEnabled: true }),
    getPullRequest: async () => ({
      number: 1,
      title: "PR",
      url: "https://github.com/getpaseo/paseo/pull/1",
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: "feature",
      labels: [],
    }),
    getPullRequestHeadRef: async () => "feature",
    getCurrentPullRequestStatus: async () => {
      options?.onStatus?.();
      return status;
    },
    createPullRequest: async () => ({
      url: "https://github.com/getpaseo/paseo/pull/1",
      number: 1,
    }),
    isAuthenticated: async () => true,
    invalidate: () => {},
  };
}

function createPullRequestStatus(overrides?: Partial<GitHubCurrentPullRequestStatus>) {
  return {
    url: "https://github.com/getpaseo/paseo/pull/123",
    title: "Ship feature",
    state: "open",
    baseRefName: "main",
    headRefName: "feature",
    isMerged: false,
    checks: [],
    checksStatus: "none" as const,
    reviewDecision: null,
    ...overrides,
  };
}

function setupRemoteTrackingMain(
  repoDir: string,
  tempDir: string,
): { remoteDir: string; cloneDir: string } {
  const remoteDir = join(tempDir, "remote.git");
  const cloneDir = join(tempDir, "upstream-clone");
  execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });
  execFileSync("git", ["clone", remoteDir, cloneDir]);
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: cloneDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
  return { remoteDir, cloneDir };
}

function commitFile(cwd: string, path: string, content: string, message: string): void {
  writeFileSync(join(cwd, path), content);
  execFileSync("git", ["add", path], { cwd });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", message], { cwd });
}

describe("checkout git utilities", () => {
  let tempDir: string;
  let repoDir: string;
  let paseoHome: string;

  beforeEach(() => {
    const setup = initRepo();
    tempDir = setup.tempDir;
    repoDir = setup.repoDir;
    paseoHome = join(tempDir, "paseo-home");
    __resetCheckoutShortstatCacheForTests();
    __resetPullRequestStatusCacheForTests();
  });

  afterEach(() => {
    __resetCheckoutShortstatCacheForTests();
    __resetPullRequestStatusCacheForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws NotGitRepoError for non-git directories", async () => {
    const nonGitDir = join(tempDir, "not-git");
    mkdirSync(nonGitDir, { recursive: true });

    await expect(getCheckoutDiff(nonGitDir, { mode: "uncommitted" })).rejects.toBeInstanceOf(
      NotGitRepoError,
    );
  });

  it("returns null for getCurrentBranch in a repo with no commits", async () => {
    const emptyRepo = join(tempDir, "empty-repo");
    mkdirSync(emptyRepo, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: emptyRepo });

    const branch = await getCurrentBranch(emptyRepo);
    expect(branch).toBeNull();
  });

  it("returns the branch being rebased when HEAD is detached during a rebase", async () => {
    execFileSync("git", ["checkout", "-b", "feature/rebase-test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "feature\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature change"], {
      cwd: repoDir,
    });

    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "main\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "main change"], {
      cwd: repoDir,
    });

    execFileSync("git", ["checkout", "feature/rebase-test"], { cwd: repoDir });
    expect(() =>
      execFileSync("git", ["rebase", "main"], { cwd: repoDir, stdio: "pipe" }),
    ).toThrow();

    const branch = await getCurrentBranch(repoDir);
    expect(branch).toBe("feature/rebase-test");
  });

  it("handles status/diff/commit in a normal repo", async () => {
    writeFileSync(join(repoDir, "file.txt"), "updated\n");

    const status = await getCheckoutStatus(repoDir);
    expect(status.isGit).toBe(true);
    expect(status.currentBranch).toBe("main");
    expect(status.isDirty).toBe(true);
    expect(status.hasRemote).toBe(false);

    const diff = await getCheckoutDiff(repoDir, { mode: "uncommitted" });
    expect(diff.diff).toContain("-hello");
    expect(diff.diff).toContain("+updated");

    await commitAll(repoDir, "update file");

    const cleanStatus = await getCheckoutStatus(repoDir);
    expect(cleanStatus.isDirty).toBe(false);
    const message = execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd: repoDir })
      .toString()
      .trim();
    expect(message).toBe("update file");
  });

  it("hides whitespace-only changes when requested", async () => {
    writeFileSync(join(repoDir, "file.txt"), "hello  \n");

    const visibleDiff = await getCheckoutDiff(repoDir, { mode: "uncommitted" });
    expect(visibleDiff.diff).toContain("file.txt");

    const hiddenDiff = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      ignoreWhitespace: true,
      includeStructured: true,
    });
    expect(hiddenDiff.diff).toBe("");
    expect(hiddenDiff.structured).toEqual([]);
  });

  it("preserves removed-line syntax highlighting with structured diffs", async () => {
    const originalContent = `/*
comment line 1
comment line 2
comment line 3
comment line 4
comment line 5
comment line 6
old comment line
comment line 8
*/
const x = 1;
`;
    const updatedContent = `/*
comment line 1
comment line 2
comment line 3
comment line 4
comment line 5
comment line 6
new comment line
comment line 8
*/
const x = 1;
`;

    writeFileSync(join(repoDir, "example.ts"), originalContent);
    execFileSync("git", ["add", "example.ts"], { cwd: repoDir });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-m", "add multiline comment fixture"],
      {
        cwd: repoDir,
      },
    );

    writeFileSync(join(repoDir, "example.ts"), updatedContent);

    const diff = await getCheckoutDiff(repoDir, { mode: "uncommitted", includeStructured: true });
    const file = diff.structured?.find((entry) => entry.path === "example.ts");
    const removedLine = file?.hunks[0]?.lines.find((line) => line.type === "remove");
    const addedLine = file?.hunks[0]?.lines.find((line) => line.type === "add");

    expect(addedLine?.tokens).toEqual([{ text: "new comment line", style: "comment" }]);
    expect(removedLine?.tokens).toEqual([{ text: "old comment line", style: "comment" }]);
  });

  it("returns checkout root metadata for normal repos", async () => {
    const status = await getCheckoutStatus(repoDir);
    expect(status.isGit).toBe(true);
    if (!status.isGit) {
      return;
    }
    expect(status.currentBranch).toBe("main");
    expect(realpathSync.native(status.repoRoot)).toBe(realpathSync.native(repoDir));
    expect(status.isPaseoOwnedWorktree).toBe(false);
    expect(status.mainRepoRoot ?? null).toBeNull();
  });

  it("exposes hasRemote when origin is configured", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });

    const status = await getCheckoutStatus(repoDir);
    expect(status.isGit).toBe(true);
    if (status.isGit) {
      expect(status.hasRemote).toBe(true);
    }
  });

  it("reports ahead/behind relative to origin on the base branch", async () => {
    const remoteDir = join(tempDir, "remote.git");
    const cloneDir = join(tempDir, "clone");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    execFileSync("git", ["clone", remoteDir, cloneDir]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: cloneDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    writeFileSync(join(cloneDir, "file.txt"), "remote\n");
    execFileSync("git", ["add", "file.txt"], { cwd: cloneDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "remote update"], {
      cwd: cloneDir,
    });
    execFileSync("git", ["push"], { cwd: cloneDir });

    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });
    const behindStatus = await getCheckoutStatus(repoDir);
    expect(behindStatus.isGit).toBe(true);
    if (!behindStatus.isGit) {
      return;
    }
    expect(behindStatus.aheadOfOrigin).toBe(0);
    expect(behindStatus.behindOfOrigin).toBe(1);

    writeFileSync(join(repoDir, "local.txt"), "local\n");
    execFileSync("git", ["add", "local.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "local update"], {
      cwd: repoDir,
    });

    const divergedStatus = await getCheckoutStatus(repoDir);
    expect(divergedStatus.isGit).toBe(true);
    if (!divergedStatus.isGit) {
      return;
    }
    expect(divergedStatus.aheadOfOrigin).toBe(1);
    expect(divergedStatus.behindOfOrigin).toBe(1);
  });

  it("does not report incoming additions when the base branch is behind its remote", async () => {
    const { cloneDir } = setupRemoteTrackingMain(repoDir, tempDir);
    commitFile(cloneDir, "file.txt", "remote one\nremote two\n", "remote update");
    execFileSync("git", ["push"], { cwd: cloneDir });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toBeNull();
  });

  it("does not report incoming deletions when the base branch is behind its remote", async () => {
    const { cloneDir } = setupRemoteTrackingMain(repoDir, tempDir);
    commitFile(cloneDir, "file.txt", "", "remote deletion");
    execFileSync("git", ["push"], { cwd: cloneDir });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toBeNull();
  });

  it("reports outgoing changes when the base branch is ahead of its remote", async () => {
    setupRemoteTrackingMain(repoDir, tempDir);
    commitFile(repoDir, "file.txt", "local one\nlocal two\n", "local update");

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toEqual({ additions: 2, deletions: 1 });
  });

  it("uses the merge-base for shortstat when the base branch diverged from its remote", async () => {
    const { cloneDir } = setupRemoteTrackingMain(repoDir, tempDir);
    commitFile(cloneDir, "file.txt", "remote one\nremote two\n", "remote update");
    execFileSync("git", ["push"], { cwd: cloneDir });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });
    commitFile(repoDir, "local.txt", "local\n", "local update");

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toEqual({ additions: 1, deletions: 0 });
  });

  it("keeps base branch divergence pointed at local work when the remote has more commits", async () => {
    const { cloneDir } = setupRemoteTrackingMain(repoDir, tempDir);
    commitFile(cloneDir, "remote-one.txt", "remote one\n", "remote update one");
    commitFile(cloneDir, "remote-two.txt", "remote two\n", "remote update two");
    execFileSync("git", ["push"], { cwd: cloneDir });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });
    commitFile(repoDir, "local.txt", "local\n", "local update");

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toEqual({ additions: 1, deletions: 0 });
  });

  it("reports only working tree changes when the base branch is behind", async () => {
    commitFile(repoDir, "tracked.txt", "tracked base\n", "add tracked file");
    const { cloneDir } = setupRemoteTrackingMain(repoDir, tempDir);
    commitFile(cloneDir, "incoming.txt", "incoming\n", "remote incoming");
    execFileSync("git", ["push"], { cwd: cloneDir });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });
    writeFileSync(join(repoDir, "tracked.txt"), "local one\nlocal two\n");

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toEqual({ additions: 2, deletions: 1 });
  });

  it("keeps feature shortstat scoped to feature changes when the base remote is ahead", async () => {
    const { cloneDir } = setupRemoteTrackingMain(repoDir, tempDir);
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    commitFile(repoDir, "feature.txt", "feature\n", "feature update");
    execFileSync("git", ["checkout", "main"], { cwd: cloneDir });
    commitFile(cloneDir, "base.txt", "base\n", "base update");
    execFileSync("git", ["push"], { cwd: cloneDir });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toEqual({ additions: 1, deletions: 0 });
  });

  it("does not report incoming base changes when a feature branch has no local work beyond merge-base", async () => {
    const { cloneDir } = setupRemoteTrackingMain(repoDir, tempDir);
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    execFileSync("git", ["checkout", "main"], { cwd: cloneDir });
    commitFile(cloneDir, "incoming.txt", "incoming\n", "remote incoming");
    execFileSync("git", ["push"], { cwd: cloneDir });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toBeNull();
  });

  it("reports feature shortstat ahead of the comparison merge-base", async () => {
    setupRemoteTrackingMain(repoDir, tempDir);
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    commitFile(repoDir, "feature.txt", "feature\n", "feature update");

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toEqual({ additions: 1, deletions: 0 });
  });

  it("includes untracked file lines in shortstat additions", async () => {
    setupRemoteTrackingMain(repoDir, tempDir);
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    commitFile(repoDir, "committed.txt", "one\n", "add committed");
    writeFileSync(join(repoDir, "untracked.txt"), "line1\nline2\nline3\n");

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toEqual({ additions: 4, deletions: 0 });
  });

  it("reports untracked-only additions when no tracked changes exist", async () => {
    setupRemoteTrackingMain(repoDir, tempDir);
    writeFileSync(join(repoDir, "newfile.txt"), "a\nb\n");

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toEqual({ additions: 2, deletions: 0 });
  });

  it("counts empty untracked files as 0 additions", async () => {
    setupRemoteTrackingMain(repoDir, tempDir);
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    commitFile(repoDir, "committed.txt", "one\n", "add committed");
    writeFileSync(join(repoDir, "empty.txt"), "");

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toEqual({ additions: 1, deletions: 0 });
  });

  it("uses the merge-base for shortstat when a feature branch diverged from its tracked remote", async () => {
    setupRemoteTrackingMain(repoDir, tempDir);
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "feature"], { cwd: repoDir });
    const featureCloneDir = join(tempDir, "feature-clone");
    execFileSync("git", ["clone", join(tempDir, "remote.git"), featureCloneDir]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: featureCloneDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: featureCloneDir });
    execFileSync("git", ["checkout", "feature"], { cwd: featureCloneDir });
    commitFile(featureCloneDir, "remote-feature.txt", "remote feature\n", "remote feature update");
    execFileSync("git", ["push"], { cwd: featureCloneDir });
    commitFile(repoDir, "local-feature.txt", "local feature\n", "local feature update");
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toEqual({ additions: 1, deletions: 0 });
  });

  it("uses the remote-only base branch as the feature shortstat comparison", async () => {
    const { cloneDir } = setupRemoteTrackingMain(repoDir, tempDir);
    execFileSync("git", ["remote", "set-head", "origin", "main"], { cwd: repoDir });
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    commitFile(repoDir, "feature.txt", "feature\n", "feature update");
    execFileSync("git", ["branch", "-D", "main"], { cwd: repoDir });
    commitFile(cloneDir, "base.txt", "base\n", "base update");
    execFileSync("git", ["push"], { cwd: cloneDir });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toEqual({ additions: 1, deletions: 0 });
  });

  it("returns no shortstat for a clean base branch that is up to date with its remote", async () => {
    setupRemoteTrackingMain(repoDir, tempDir);
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toBeNull();
  });

  it("reports working tree changes when the base branch has no ahead commits", async () => {
    setupRemoteTrackingMain(repoDir, tempDir);
    writeFileSync(join(repoDir, "file.txt"), "local one\nlocal two\n");

    const shortstat = await getCheckoutShortstat(repoDir);

    expect(shortstat).toEqual({ additions: 2, deletions: 1 });
  });

  it("uses the freshest comparison base for status and shortstat when local main is stale", async () => {
    const remoteDir = join(tempDir, "remote.git");
    const cloneDir = join(tempDir, "clone");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    execFileSync("git", ["clone", remoteDir, cloneDir]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: cloneDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    writeFileSync(join(cloneDir, "upstream.txt"), "upstream 1\nupstream 2\n");
    execFileSync("git", ["add", "upstream.txt"], { cwd: cloneDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "remote update"], {
      cwd: cloneDir,
    });
    execFileSync("git", ["push"], { cwd: cloneDir });

    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });
    execFileSync("git", ["checkout", "-b", "feature", "origin/main"], { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature update"], {
      cwd: repoDir,
    });

    const status = await getCheckoutStatus(repoDir);
    expect(status.isGit).toBe(true);
    if (!status.isGit) {
      return;
    }
    expect(status.baseRef).toBe("main");
    expect(status.aheadBehind).toEqual({ ahead: 1, behind: 0 });

    const shortstat = await getCheckoutShortstat(repoDir);
    expect(shortstat).toEqual({ additions: 1, deletions: 0 });
  });

  it("does not count origin base commits as feature changes when local main is stale", async () => {
    const remoteDir = join(tempDir, "remote.git");
    const otherClone = join(tempDir, "other-clone");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    execFileSync("git", ["clone", remoteDir, otherClone]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: otherClone });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: otherClone });
    writeFileSync(join(otherClone, "already-on-origin.txt"), "origin\n");
    execFileSync("git", ["add", "already-on-origin.txt"], { cwd: otherClone });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "origin base commit"], {
      cwd: otherClone,
    });
    execFileSync("git", ["push"], { cwd: otherClone });

    writeFileSync(join(repoDir, "local-only-base.txt"), "local\n");
    execFileSync("git", ["add", "local-only-base.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "local base drift"], {
      cwd: repoDir,
    });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });
    execFileSync("git", ["checkout", "-b", "feature", "origin/main"], { cwd: repoDir });

    const shortstat = await getCheckoutShortstat(repoDir);
    expect(shortstat).toBeNull();

    const diff = await getCheckoutDiff(repoDir, {
      mode: "base",
      baseRef: "main",
      includeStructured: true,
    });
    expect(diff.diff).toBe("");
    expect(diff.structured).toEqual([]);
  });

  it("falls back to the local base branch when origin is absent", async () => {
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "local-feature.txt"), "feature\n");
    execFileSync("git", ["add", "local-feature.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "local feature"], {
      cwd: repoDir,
    });

    const shortstat = await getCheckoutShortstat(repoDir);
    expect(shortstat).toEqual({ additions: 1, deletions: 0 });

    const diff = await getCheckoutDiff(repoDir, { mode: "base", baseRef: "main" });
    expect(diff.diff).toContain("local-feature.txt");
  });

  it("keeps an explicit origin base ref instead of stripping it to a stale local branch", async () => {
    const remoteDir = join(tempDir, "remote.git");
    const otherClone = join(tempDir, "other-clone");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    execFileSync("git", ["clone", remoteDir, otherClone]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: otherClone });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: otherClone });
    writeFileSync(join(otherClone, "origin-base.txt"), "origin\n");
    execFileSync("git", ["add", "origin-base.txt"], { cwd: otherClone });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "origin base"], {
      cwd: otherClone,
    });
    execFileSync("git", ["push"], { cwd: otherClone });

    writeFileSync(join(repoDir, "local-drift.txt"), "local\n");
    execFileSync("git", ["add", "local-drift.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "local drift"], {
      cwd: repoDir,
    });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });
    execFileSync("git", ["checkout", "-b", "feature", "origin/main"], { cwd: repoDir });

    const diff = await getCheckoutDiff(repoDir, { mode: "base", baseRef: "origin/main" });
    expect(diff.diff).toBe("");
  });

  it("shows feature commits when the local and origin base branches are up to date", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature commit"], {
      cwd: repoDir,
    });

    const shortstat = await getCheckoutShortstat(repoDir);
    expect(shortstat).toEqual({ additions: 1, deletions: 0 });

    const diff = await getCheckoutDiff(repoDir, { mode: "base", baseRef: "main" });
    expect(diff.diff).toContain("feature.txt");
  });

  it("does not include dirty working tree changes in base mode", async () => {
    writeFileSync(join(repoDir, "file.txt"), "dirty\n");
    writeFileSync(join(repoDir, "untracked.txt"), "untracked\n");

    const diff = await getCheckoutDiff(repoDir, {
      mode: "base",
      baseRef: "main",
      includeStructured: true,
    });

    expect(diff.diff).toBe("");
    expect(diff.structured).toEqual([]);
  });

  it("shows committed branch changes without dirty working tree changes in base mode", async () => {
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature commit"], {
      cwd: repoDir,
    });

    writeFileSync(join(repoDir, "file.txt"), "dirty\n");
    writeFileSync(join(repoDir, "untracked.txt"), "untracked\n");

    const diff = await getCheckoutDiff(repoDir, {
      mode: "base",
      baseRef: "main",
      includeStructured: true,
    });

    expect(diff.diff).toContain("feature.txt");
    expect(diff.diff).not.toContain("file.txt");
    expect(diff.diff).not.toContain("untracked.txt");
    expect(diff.structured?.map((file) => file.path)).toEqual(["feature.txt"]);
  });

  it("warms shortstat cache in the background without blocking listing callers", async () => {
    expect(getCachedCheckoutShortstat(repoDir)).toBeUndefined();

    warmCheckoutShortstatInBackground(repoDir);

    // A repo with no origin/main computes to null, but null should still be cached.
    for (let attempts = 0; attempts < 20; attempts += 1) {
      const cached = getCachedCheckoutShortstat(repoDir);
      if (cached !== undefined) {
        expect(cached).toBeNull();
        return;
      }
      await sleep(25);
    }

    throw new Error("shortstat background warm did not populate cache in time");
  });

  it("commits messages with quotes safely", async () => {
    const message = `He said "hello" and it's fine`;
    writeFileSync(join(repoDir, "file.txt"), "quoted\n");

    await commitAll(repoDir, message);

    const logMessage = execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd: repoDir })
      .toString()
      .trim();
    expect(logMessage).toBe(message);
  });

  it("diffs base mode against merge-base (no base-only deletions)", async () => {
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });

    // Advance base branch after feature splits off.
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
    writeFileSync(join(repoDir, "base-only.txt"), "base\n");
    execFileSync("git", ["add", "base-only.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "base only"], {
      cwd: repoDir,
    });

    // Make a feature change.
    execFileSync("git", ["checkout", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature commit"], {
      cwd: repoDir,
    });

    const diff = await getCheckoutDiff(repoDir, { mode: "base", baseRef: "main" });
    expect(diff.diff).toContain("feature.txt");
    expect(diff.diff).not.toContain("base-only.txt");
  });

  it("does not throw on large diffs (marks file as too_large)", async () => {
    const large = Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join("\n") + "\n";
    writeFileSync(join(repoDir, "file.txt"), large);

    const diff = await getCheckoutDiff(repoDir, { mode: "uncommitted", includeStructured: true });
    expect(diff.structured?.some((f) => f.path === "file.txt" && f.status === "too_large")).toBe(
      true,
    );
  });

  it("short-circuits tracked binary files", async () => {
    const trackedBinaryPath = join(repoDir, "tracked-blob.bin");
    writeFileSync(trackedBinaryPath, Buffer.from([0x00, 0xff, 0x10, 0x80, 0x00]));
    execFileSync("git", ["add", "tracked-blob.bin"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add tracked binary"], {
      cwd: repoDir,
    });

    writeFileSync(trackedBinaryPath, Buffer.from([0x00, 0xff, 0x11, 0x81, 0x00]));

    const diff = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    const entry = diff.structured?.find((file) => file.path === "tracked-blob.bin");
    expect(entry).toBeTruthy();
    expect(entry?.status).toBe("binary");
    expect(diff.diff).toContain("# tracked-blob.bin: binary diff omitted");
  });

  it("short-circuits untracked binary files", async () => {
    const binaryPath = join(repoDir, "blob.bin");
    writeFileSync(binaryPath, Buffer.from([0x00, 0xff, 0x10, 0x80, 0x00, 0x7f, 0x00]));

    const diff = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    const entry = diff.structured?.find((file) => file.path === "blob.bin");
    expect(entry).toBeTruthy();
    expect(entry?.status).toBe("binary");
    expect(diff.diff).toContain("# blob.bin: binary diff omitted");
  });

  it("marks untracked oversized files as too_large", async () => {
    const large = Array.from({ length: 240_000 }, (_, i) => `line ${i}`).join("\n") + "\n";
    writeFileSync(join(repoDir, "untracked-large.txt"), large);

    const diff = await getCheckoutDiff(repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });

    const entry = diff.structured?.find((file) => file.path === "untracked-large.txt");
    expect(entry).toBeTruthy();
    expect(entry?.status).toBe("too_large");
    expect(diff.diff).toContain("# untracked-large.txt: diff too large omitted");
  });

  it("handles status/diff/commit in a .paseo worktree", async () => {
    const result = await createLegacyWorktreeForTest({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "alpha",
      paseoHome,
    });

    writeFileSync(join(result.worktreePath, "file.txt"), "worktree change\n");

    const status = await getCheckoutStatus(result.worktreePath, { paseoHome });
    expect(status.isGit).toBe(true);
    expect(realpathSync.native(status.repoRoot)).toBe(realpathSync.native(result.worktreePath));
    expect(status.isDirty).toBe(true);
    expect(status.isPaseoOwnedWorktree).toBe(true);
    expect(realpathSync.native(status.mainRepoRoot ?? "")).toBe(realpathSync.native(repoDir));

    const diff = await getCheckoutDiff(result.worktreePath, { mode: "uncommitted" }, { paseoHome });
    expect(diff.diff).toContain("-hello");
    expect(diff.diff).toContain("+worktree change");

    await commitAll(result.worktreePath, "worktree update");

    const cleanStatus = await getCheckoutStatus(result.worktreePath, { paseoHome });
    expect(cleanStatus.isDirty).toBe(false);
    const message = execFileSync("git", ["log", "-1", "--pretty=%B"], {
      cwd: result.worktreePath,
    })
      .toString()
      .trim();
    expect(message).toBe("worktree update");
  });

  it("returns checkout root metadata for .paseo worktrees", async () => {
    const result = await createLegacyWorktreeForTest({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "lite-alpha",
      paseoHome,
    });

    const status = await getCheckoutStatus(result.worktreePath, { paseoHome });
    expect(status.isGit).toBe(true);
    if (!status.isGit) {
      return;
    }
    expect(realpathSync.native(status.repoRoot)).toBe(realpathSync.native(result.worktreePath));
    expect(status.isPaseoOwnedWorktree).toBe(true);
    expect(realpathSync.native(status.mainRepoRoot ?? "")).toBe(realpathSync.native(repoDir));
  });

  it("returns mainRepoRoot pointing to first non-bare worktree for bare repos", async () => {
    const bareRepoDir = join(tempDir, "bare-repo");
    execFileSync("git", ["clone", "--bare", repoDir, bareRepoDir]);

    const mainCheckoutDir = join(tempDir, "main-checkout");
    execFileSync("git", ["-C", bareRepoDir, "worktree", "add", mainCheckoutDir, "main"]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: mainCheckoutDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: mainCheckoutDir });

    const worktree = await createLegacyWorktreeForTest({
      branchName: "feature",
      cwd: mainCheckoutDir,
      baseBranch: "main",
      worktreeSlug: "feature-worktree",
      paseoHome,
    });

    const status = await getCheckoutStatus(worktree.worktreePath, { paseoHome });
    expect(status.isGit).toBe(true);
    expect(status.isPaseoOwnedWorktree).toBe(true);
    expect(realpathSync.native(status.mainRepoRoot ?? "")).toBe(
      realpathSync.native(mainCheckoutDir),
    );
  });

  it("detects plain git worktrees from git alone", async () => {
    const worktreeDir = join(tempDir, "plain-git-worktree");
    execFileSync("git", ["worktree", "add", "-b", "feature/plain", worktreeDir, "main"], {
      cwd: repoDir,
    });

    const status = await getCheckoutStatus(worktreeDir, { paseoHome });
    expect(status.isGit).toBe(true);
    expect(realpathSync.native(status.repoRoot)).toBe(realpathSync.native(worktreeDir));
    expect(status.isPaseoOwnedWorktree).toBe(false);
    expect(realpathSync.native(status.mainRepoRoot ?? "")).toBe(realpathSync.native(repoDir));
    expect(status.currentBranch).toBe("feature/plain");
  });

  it("merges the current branch into base from a worktree checkout", async () => {
    const worktree = await createLegacyWorktreeForTest({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "merge",
      paseoHome,
    });

    writeFileSync(join(worktree.worktreePath, "merge.txt"), "feature\n");
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: worktree.worktreePath });
    execFileSync("git", ["add", "merge.txt"], { cwd: worktree.worktreePath });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature commit"], {
      cwd: worktree.worktreePath,
    });
    const featureCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree.worktreePath })
      .toString()
      .trim();

    await mergeToBase(worktree.worktreePath, { baseRef: "main" }, { paseoHome });

    const baseContainsFeature = execFileSync(
      "git",
      ["merge-base", "--is-ancestor", featureCommit, "main"],
      {
        cwd: repoDir,
        stdio: "pipe",
      },
    );
    expect(baseContainsFeature).toBeDefined();

    const statusAfterMerge = await getCheckoutStatus(worktree.worktreePath, { paseoHome });
    expect(statusAfterMerge.isGit).toBe(true);
    if (statusAfterMerge.isGit) {
      expect(statusAfterMerge.aheadBehind?.ahead ?? 0).toBe(0);
    }

    const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktree.worktreePath,
    })
      .toString()
      .trim();
    expect(currentBranch).toBe("feature");
  });

  it("reports the base worktree cwd when merge-to-base mutates a separate checkout", async () => {
    execFileSync("git", ["checkout", "-b", "develop"], { cwd: repoDir });
    writeFileSync(join(repoDir, "develop.txt"), "develop\n");
    execFileSync("git", ["add", "develop.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "develop commit"], {
      cwd: repoDir,
    });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });

    const baseWorktreePath = join(tempDir, "base-worktree");
    execFileSync("git", ["worktree", "add", baseWorktreePath, "develop"], { cwd: repoDir });

    const featureWorktree = await createLegacyWorktreeForTest({
      branchName: "feature",
      cwd: repoDir,
      baseBranch: "develop",
      worktreeSlug: "feature-worktree",
      paseoHome,
    });

    writeFileSync(join(featureWorktree.worktreePath, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: featureWorktree.worktreePath });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature commit"], {
      cwd: featureWorktree.worktreePath,
    });

    const mutatedCwd = await mergeToBase(featureWorktree.worktreePath, {}, { paseoHome });

    expect(realpathSync.native(mutatedCwd)).toBe(realpathSync.native(baseWorktreePath));
    expect(mutatedCwd).not.toBe(featureWorktree.worktreePath);
  });

  it("merges from the most-ahead base ref (origin/main when it is ahead)", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    // Advance origin/main without advancing local main.
    const otherClone = join(tempDir, "other-clone");
    execFileSync("git", ["clone", remoteDir, otherClone]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: otherClone });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: otherClone });
    writeFileSync(join(otherClone, "remote-only.txt"), "remote\n");
    execFileSync("git", ["add", "remote-only.txt"], { cwd: otherClone });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "remote only"], {
      cwd: otherClone,
    });
    const remoteOnlyCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: otherClone })
      .toString()
      .trim();
    execFileSync("git", ["push"], { cwd: otherClone });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature commit"], {
      cwd: repoDir,
    });

    await mergeFromBase(repoDir, { baseRef: "main", requireCleanTarget: true });

    execFileSync("git", ["merge-base", "--is-ancestor", remoteOnlyCommit, "feature"], {
      cwd: repoDir,
    });
  });

  it("merges from the most-ahead base ref (local main when it is ahead)", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    // Advance local main without pushing.
    writeFileSync(join(repoDir, "local-only.txt"), "local\n");
    execFileSync("git", ["add", "local-only.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "local only"], {
      cwd: repoDir,
    });
    const localOnlyCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir })
      .toString()
      .trim();

    execFileSync("git", ["checkout", "-b", "feature", `${localOnlyCommit}~1`], { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature commit"], {
      cwd: repoDir,
    });

    await mergeFromBase(repoDir, { baseRef: "main", requireCleanTarget: true });

    execFileSync("git", ["merge-base", "--is-ancestor", localOnlyCommit, "feature"], {
      cwd: repoDir,
    });
  });

  it("aborts merge-from-base on conflicts and leaves no merge in progress", async () => {
    writeFileSync(join(repoDir, "conflict.txt"), "base\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add conflict file"], {
      cwd: repoDir,
    });

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "conflict.txt"), "feature\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature change"], {
      cwd: repoDir,
    });

    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
    writeFileSync(join(repoDir, "conflict.txt"), "main change\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "main change"], {
      cwd: repoDir,
    });

    execFileSync("git", ["checkout", "feature"], { cwd: repoDir });

    await expect(
      mergeFromBase(repoDir, { baseRef: "main", requireCleanTarget: true }),
    ).rejects.toBeInstanceOf(MergeFromBaseConflictError);

    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir })
      .toString()
      .trim();
    expect(porcelain).toBe("");
    expect(() =>
      execFileSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: repoDir }),
    ).toThrow();
  });

  it("pulls the current branch from origin", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    const otherClone = join(tempDir, "other-clone");
    execFileSync("git", ["clone", remoteDir, otherClone]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: otherClone });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: otherClone });
    writeFileSync(join(otherClone, "pulled.txt"), "remote\n");
    execFileSync("git", ["add", "pulled.txt"], { cwd: otherClone });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "remote pull commit"], {
      cwd: otherClone,
    });
    const remoteCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: otherClone })
      .toString()
      .trim();
    execFileSync("git", ["push"], { cwd: otherClone });

    await pullCurrentBranch(repoDir);

    execFileSync("git", ["merge-base", "--is-ancestor", remoteCommit, "HEAD"], { cwd: repoDir });
    expect(readFileSync(join(repoDir, "pulled.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
      "remote\n",
    );
  });

  it("invalidates GitHub cache after successful local git mutation paths", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    const invalidatedCwds: string[] = [];
    const github = createGitHubServiceForStatus(null);
    github.invalidate = ({ cwd }) => {
      invalidatedCwds.push(cwd);
    };

    await pullCurrentBranch(repoDir, github);

    expect(invalidatedCwds).toEqual([repoDir]);
  });

  it("aborts pull on merge conflicts and leaves no merge in progress", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    writeFileSync(join(repoDir, "conflict.txt"), "local\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "local conflict commit"], {
      cwd: repoDir,
    });

    const otherClone = join(tempDir, "other-clone");
    execFileSync("git", ["clone", remoteDir, otherClone]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: otherClone });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: otherClone });
    writeFileSync(join(otherClone, "conflict.txt"), "remote\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: otherClone });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "remote conflict commit"], {
      cwd: otherClone,
    });
    execFileSync("git", ["push"], { cwd: otherClone });

    await expect(pullCurrentBranch(repoDir)).rejects.toBeInstanceOf(Error);

    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir })
      .toString()
      .trim();
    expect(porcelain).toBe("");
    expect(() =>
      execFileSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: repoDir }),
    ).toThrow();
  });

  it("aborts pull on rebase conflicts and leaves no rebase in progress", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "pull.rebase", "true"], { cwd: repoDir });

    writeFileSync(join(repoDir, "conflict.txt"), "local\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: repoDir });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-m", "local rebase conflict commit"],
      {
        cwd: repoDir,
      },
    );

    const otherClone = join(tempDir, "other-clone");
    execFileSync("git", ["clone", remoteDir, otherClone]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: otherClone });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: otherClone });
    writeFileSync(join(otherClone, "conflict.txt"), "remote\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: otherClone });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-m", "remote rebase conflict commit"],
      {
        cwd: otherClone,
      },
    );
    execFileSync("git", ["push"], { cwd: otherClone });

    await expect(pullCurrentBranch(repoDir)).rejects.toBeInstanceOf(Error);

    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: repoDir })
      .toString()
      .trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir })
      .toString()
      .trim();
    expect(porcelain).toBe("");
    expect(existsSync(join(gitDir, "rebase-merge"))).toBe(false);
    expect(existsSync(join(gitDir, "rebase-apply"))).toBe(false);
  });

  it("pushes the current branch to origin", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "push.txt"), "push\n");
    execFileSync("git", ["add", "push.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "push commit"], {
      cwd: repoDir,
    });

    await pushCurrentBranch(repoDir);

    execFileSync("git", ["--git-dir", remoteDir, "show-ref", "--verify", "refs/heads/feature"]);
  });

  it("lists merged local and remote branch suggestions with provenance", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    execFileSync("git", ["checkout", "-b", "feature/local-only"], { cwd: repoDir });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
    execFileSync("git", ["checkout", "-b", "feature/shared"], { cwd: repoDir });
    writeFileSync(join(repoDir, "shared.txt"), "shared\n");
    execFileSync("git", ["add", "shared.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "shared branch"], {
      cwd: repoDir,
    });
    execFileSync("git", ["push", "-u", "origin", "feature/shared"], { cwd: repoDir });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });

    const otherClone = join(tempDir, "other-clone");
    execFileSync("git", ["clone", remoteDir, otherClone]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: otherClone });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: otherClone });
    execFileSync("git", ["checkout", "-b", "feature/remote-only"], { cwd: otherClone });
    writeFileSync(join(otherClone, "remote-only.txt"), "remote-only\n");
    execFileSync("git", ["add", "remote-only.txt"], { cwd: otherClone });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "remote only branch"], {
      cwd: otherClone,
    });
    execFileSync("git", ["push", "-u", "origin", "feature/remote-only"], { cwd: otherClone });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    const branches = await listBranchSuggestions(repoDir, { limit: 50 });
    const branchNames = branches.map((branch) => branch.name);
    expect(branchNames).toContain("main");
    expect(branchNames).toContain("feature/local-only");
    expect(branchNames).toContain("feature/remote-only");
    expect(branchNames).toContain("feature/shared");
    expect(branchNames.filter((name) => name === "main")).toHaveLength(1);
    expect(branchNames).not.toContain("HEAD");
    expect(branchNames.some((name) => name.startsWith("origin/"))).toBe(false);
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "main",
          committerDate: expect.any(Number),
        }),
      ]),
    );
    expect(branches.find((branch) => branch.name === "feature/local-only")).toMatchObject({
      hasLocal: true,
      hasRemote: false,
    });
    expect(branches.find((branch) => branch.name === "feature/remote-only")).toMatchObject({
      hasLocal: false,
      hasRemote: true,
    });
    expect(branches.find((branch) => branch.name === "feature/shared")).toMatchObject({
      hasLocal: true,
      hasRemote: true,
    });
  });

  it("resolves branch checkout targets with local precedence and origin normalization", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    execFileSync("git", ["checkout", "-b", "feature/local"], { cwd: repoDir });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
    execFileSync("git", ["checkout", "-b", "feature/shared"], { cwd: repoDir });
    writeFileSync(join(repoDir, "shared.txt"), "shared\n");
    execFileSync("git", ["add", "shared.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "shared branch"], {
      cwd: repoDir,
    });
    execFileSync("git", ["push", "-u", "origin", "feature/shared"], { cwd: repoDir });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });

    const otherClone = join(tempDir, "other-clone");
    execFileSync("git", ["clone", remoteDir, otherClone]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: otherClone });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: otherClone });
    execFileSync("git", ["checkout", "-b", "feature/remote-only"], { cwd: otherClone });
    writeFileSync(join(otherClone, "remote-only.txt"), "remote-only\n");
    execFileSync("git", ["add", "remote-only.txt"], { cwd: otherClone });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "remote only branch"], {
      cwd: otherClone,
    });
    execFileSync("git", ["push", "-u", "origin", "feature/remote-only"], { cwd: otherClone });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    await expect(resolveBranchCheckout(repoDir, "feature/local")).resolves.toEqual({
      kind: "local",
      name: "feature/local",
    });
    await expect(resolveBranchCheckout(repoDir, "feature/remote-only")).resolves.toEqual({
      kind: "remote-only",
      name: "feature/remote-only",
      remoteRef: "origin/feature/remote-only",
    });
    await expect(resolveBranchCheckout(repoDir, "origin/feature/remote-only")).resolves.toEqual({
      kind: "remote-only",
      name: "feature/remote-only",
      remoteRef: "origin/feature/remote-only",
    });
    await expect(resolveBranchCheckout(repoDir, "feature/shared")).resolves.toEqual({
      kind: "local",
      name: "feature/shared",
    });
    await expect(resolveBranchCheckout(repoDir, "feature/unknown")).resolves.toEqual({
      kind: "not-found",
    });
  });

  it("does not resolve tags as branch checkout targets", async () => {
    execFileSync("git", ["checkout", "-b", "feature/a"], { cwd: repoDir });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
    execFileSync("git", ["tag", "v1"], { cwd: repoDir });

    await expect(resolveBranchCheckout(repoDir, "v1")).resolves.toEqual({
      kind: "not-found",
    });
  });

  it("checks out a remote-only branch as a local tracking branch", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    const otherClone = join(tempDir, "other-clone");
    execFileSync("git", ["clone", remoteDir, otherClone]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: otherClone });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: otherClone });
    execFileSync("git", ["checkout", "-b", "feature/remote-only"], { cwd: otherClone });
    writeFileSync(join(otherClone, "remote-only.txt"), "remote-only\n");
    execFileSync("git", ["add", "remote-only.txt"], { cwd: otherClone });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "remote only branch"], {
      cwd: otherClone,
    });
    execFileSync("git", ["push", "-u", "origin", "feature/remote-only"], { cwd: otherClone });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    const resolution = await resolveBranchCheckout(repoDir, "feature/remote-only");
    await expect(checkoutResolvedBranch({ cwd: repoDir, resolution })).resolves.toEqual({
      source: "remote",
    });

    expect(
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repoDir }).toString().trim(),
    ).toBe("feature/remote-only");
    execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: repoDir });
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
        cwd: repoDir,
      })
        .toString()
        .trim(),
    ).toBe("origin/feature/remote-only");
  });

  it("normalizes explicit origin input when checking out a remote-only branch", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

    const otherClone = join(tempDir, "other-clone");
    execFileSync("git", ["clone", remoteDir, otherClone]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: otherClone });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: otherClone });
    execFileSync("git", ["checkout", "-b", "feature/remote-only"], { cwd: otherClone });
    writeFileSync(join(otherClone, "remote-only.txt"), "remote-only\n");
    execFileSync("git", ["add", "remote-only.txt"], { cwd: otherClone });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "remote only branch"], {
      cwd: otherClone,
    });
    execFileSync("git", ["push", "-u", "origin", "feature/remote-only"], { cwd: otherClone });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    const resolution = await resolveBranchCheckout(repoDir, "origin/feature/remote-only");
    await expect(checkoutResolvedBranch({ cwd: repoDir, resolution })).resolves.toEqual({
      source: "remote",
    });

    expect(
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repoDir }).toString().trim(),
    ).toBe("feature/remote-only");
    execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: repoDir });
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
        cwd: repoDir,
      })
        .toString()
        .trim(),
    ).toBe("origin/feature/remote-only");
  });

  it("checks out the local branch when local and remote branches share a name", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });
    execFileSync("git", ["checkout", "-b", "feature/shared"], { cwd: repoDir });
    writeFileSync(join(repoDir, "shared.txt"), "shared\n");
    execFileSync("git", ["add", "shared.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "shared branch"], {
      cwd: repoDir,
    });
    execFileSync("git", ["push", "-u", "origin", "feature/shared"], { cwd: repoDir });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });

    const resolution = await resolveBranchCheckout(repoDir, "feature/shared");
    await expect(checkoutResolvedBranch({ cwd: repoDir, resolution })).resolves.toEqual({
      source: "local",
    });

    expect(
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repoDir }).toString().trim(),
    ).toBe("feature/shared");
  });

  it("throws the existing branch-not-found message for unknown checkout targets", async () => {
    await expect(
      checkoutResolvedBranch({
        cwd: repoDir,
        resolution: { kind: "not-found" },
        requestedBranch: "missing-branch",
      }),
    ).rejects.toThrow(/^Branch not found: missing-branch$/);
  });

  it("filters branch suggestions by query and enforces result limit", async () => {
    execFileSync("git", ["checkout", "-b", "feature/alpha"], { cwd: repoDir });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
    execFileSync("git", ["checkout", "-b", "feature/beta"], { cwd: repoDir });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
    execFileSync("git", ["checkout", "-b", "chore/docs"], { cwd: repoDir });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });

    const branches = await listBranchSuggestions(repoDir, {
      query: "FEATURE/",
      limit: 1,
    });
    expect(branches).toHaveLength(1);
    expect(branches[0]?.name.toLowerCase()).toContain("feature/");
    expect(branches[0]?.committerDate).toEqual(expect.any(Number));
  });

  it("disables GitHub features when gh is unavailable", async () => {
    execFileSync("git", ["remote", "add", "origin", "https://github.com/getpaseo/paseo.git"], {
      cwd: repoDir,
    });

    const github = createGitHubServiceForStatus(null);
    github.getCurrentPullRequestStatus = async () => {
      throw new GitHubCliMissingError();
    };
    const status = await getPullRequestStatus(repoDir, github);
    expect(status.githubFeaturesEnabled).toBe(false);
    expect(status.status).toBeNull();
  });

  it("returns merged PR status when no open PR exists for the current branch", async () => {
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/getpaseo/paseo.git"], {
      cwd: repoDir,
    });

    const status = await getPullRequestStatus(
      repoDir,
      createGitHubServiceForStatus(
        createPullRequestStatus({
          state: "merged",
          isMerged: true,
        }),
      ),
    );
    expect(status.githubFeaturesEnabled).toBe(true);
    expect(status.status).not.toBeNull();
    expect(status.status?.url).toContain("/pull/123");
    expect(status.status?.baseRefName).toBe("main");
    expect(status.status?.headRefName).toBe("feature");
    expect(status.status?.isMerged).toBe(true);
    expect(status.status?.state).toBe("merged");
  });

  it("propagates S1 PR metadata and check display fields through checkout PR status", async () => {
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/getpaseo/paseo.git"], {
      cwd: repoDir,
    });

    const status = await getPullRequestStatus(
      repoDir,
      createGitHubServiceForStatus(
        createPullRequestStatus({
          number: 123,
          isDraft: true,
          checks: [
            {
              name: "server-tests",
              status: "success",
              url: "https://github.com/getpaseo/paseo/actions/runs/123",
              workflow: "Server CI",
              duration: "2m 14s",
            },
          ],
        }),
      ),
    );

    expect(status).toEqual({
      githubFeaturesEnabled: true,
      status: {
        number: 123,
        url: "https://github.com/getpaseo/paseo/pull/123",
        title: "Ship feature",
        state: "open",
        baseRefName: "main",
        headRefName: "feature",
        isMerged: false,
        isDraft: true,
        checks: [
          {
            name: "server-tests",
            status: "success",
            url: "https://github.com/getpaseo/paseo/actions/runs/123",
            workflow: "Server CI",
            duration: "2m 14s",
          },
        ],
        checksStatus: "none",
        reviewDecision: null,
      },
    });
  });

  it("uses the tracked fork branch for PR worktree status lookup", async () => {
    execFileSync("git", ["checkout", "-b", "chethanuk/main"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/getpaseo/paseo.git"], {
      cwd: repoDir,
    });
    execFileSync("git", ["remote", "add", "paseo-pr-345", "git@github.com:chethanuk/paseo.git"], {
      cwd: repoDir,
    });
    execFileSync("git", ["config", "branch.chethanuk/main.remote", "paseo-pr-345"], {
      cwd: repoDir,
    });
    execFileSync("git", ["config", "branch.chethanuk/main.merge", "refs/heads/main"], {
      cwd: repoDir,
    });

    const requestedTargets: Array<{ headRef: string; headRepositoryOwner?: string }> = [];
    const github = createGitHubServiceForStatus(
      createPullRequestStatus({
        number: 345,
        url: "https://github.com/getpaseo/paseo/pull/345",
        headRefName: "main",
      }),
      {
        onStatus: () => {},
      },
    );
    github.getCurrentPullRequestStatus = async (options) => {
      requestedTargets.push({
        headRef: options.headRef,
        ...(options.headRepositoryOwner
          ? { headRepositoryOwner: options.headRepositoryOwner }
          : {}),
      });
      return createPullRequestStatus({
        number: 345,
        url: "https://github.com/getpaseo/paseo/pull/345",
        headRefName: options.headRef,
      });
    };

    const status = await getPullRequestStatus(repoDir, github);

    expect(requestedTargets).toEqual([{ headRef: "main", headRepositoryOwner: "chethanuk" }]);
    expect(status.status?.number).toBe(345);
    expect(status.status?.headRefName).toBe("main");
  });

  it("returns closed-unmerged PR status without marking it as merged", async () => {
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/getpaseo/paseo.git"], {
      cwd: repoDir,
    });

    const status = await getPullRequestStatus(
      repoDir,
      createGitHubServiceForStatus(
        createPullRequestStatus({
          url: "https://github.com/getpaseo/paseo/pull/999",
          title: "Closed without merge",
          state: "closed",
        }),
      ),
    );
    expect(status.githubFeaturesEnabled).toBe(true);
    expect(status.status).not.toBeNull();
    expect(status.status?.url).toContain("/pull/999");
    expect(status.status?.baseRefName).toBe("main");
    expect(status.status?.headRefName).toBe("feature");
    expect(status.status?.isMerged).toBe(false);
    expect(status.status?.state).toBe("closed");
  });

  it("caches PR status results for duplicate lookups", async () => {
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/getpaseo/paseo.git"], {
      cwd: repoDir,
    });

    let callCount = 0;
    const github = createGitHubServiceForStatus(createPullRequestStatus(), {
      onStatus: () => {
        callCount += 1;
      },
    });
    const first = await getPullRequestStatus(repoDir, github);
    const second = await getPullRequestStatus(repoDir, github);
    expect(first).toEqual(second);
    expect(first.status?.url).toContain("/pull/123");
    expect(callCount).toBe(1);
  });

  it("expires cached PR status after the TTL", async () => {
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/getpaseo/paseo.git"], {
      cwd: repoDir,
    });

    __setPullRequestStatusCacheTtlForTests(50);
    try {
      let callCount = 0;
      const github = createGitHubServiceForStatus(null, {
        onStatus: () => {
          callCount += 1;
        },
      });
      github.getCurrentPullRequestStatus = async () => {
        callCount += 1;
        return createPullRequestStatus({
          url: `https://github.com/getpaseo/paseo/pull/${callCount}`,
        });
      };
      const first = await getPullRequestStatus(repoDir, github);
      await sleep(80);
      const second = await getPullRequestStatus(repoDir, github);
      expect(first.status?.url).toContain("/pull/1");
      expect(second.status?.url).toContain("/pull/2");
      expect(callCount).toBe(2);
    } finally {
      __resetPullRequestStatusCacheForTests();
    }
  });

  it("keeps stale PR status when a refresh hits a transient GitHub error", async () => {
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/getpaseo/paseo.git"], {
      cwd: repoDir,
    });

    __setPullRequestStatusCacheTtlForTests(50);
    try {
      let callCount = 0;
      const github = createGitHubServiceForStatus(null);
      github.getCurrentPullRequestStatus = async () => {
        callCount += 1;
        if (callCount === 1) {
          return createPullRequestStatus({
            url: "https://github.com/getpaseo/paseo/pull/123",
          });
        }
        throw new GitHubCommandError({
          args: ["pr", "view"],
          cwd: repoDir,
          exitCode: 1,
          stderr: "could not resolve host: github.com",
        });
      };

      const fresh = await getPullRequestStatus(repoDir, github);
      await sleep(80);
      const stale = await getPullRequestStatus(repoDir, github);

      expect(stale).toEqual(fresh);
      expect(stale.githubFeaturesEnabled).toBe(true);
      expect(stale.status?.url).toContain("/pull/123");
      expect(callCount).toBe(2);
    } finally {
      __resetPullRequestStatusCacheForTests();
    }
  });

  it("clears stale PR status after a successful no-PR refresh", async () => {
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/getpaseo/paseo.git"], {
      cwd: repoDir,
    });

    __setPullRequestStatusCacheTtlForTests(50);
    try {
      let callCount = 0;
      const github = createGitHubServiceForStatus(null);
      github.getCurrentPullRequestStatus = async () => {
        callCount += 1;
        if (callCount === 1) {
          return createPullRequestStatus({
            url: "https://github.com/getpaseo/paseo/pull/123",
          });
        }
        return null;
      };

      const fresh = await getPullRequestStatus(repoDir, github);
      await sleep(80);
      const cleared = await getPullRequestStatus(repoDir, github);

      expect(fresh.status?.url).toContain("/pull/123");
      expect(cleared).toEqual({
        githubFeaturesEnabled: true,
        status: null,
      });
      expect(callCount).toBe(2);
    } finally {
      __resetPullRequestStatusCacheForTests();
    }
  });

  it("dedupes concurrent PR status lookups for the same cwd", async () => {
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/getpaseo/paseo.git"], {
      cwd: repoDir,
    });

    let callCount = 0;
    const github = createGitHubServiceForStatus(createPullRequestStatus(), {
      onStatus: () => {
        callCount += 1;
      },
    });
    const [first, second] = await Promise.all([
      getPullRequestStatus(repoDir, github),
      getPullRequestStatus(repoDir, github),
    ]);
    expect(first).toEqual(second);
    expect(callCount).toBe(1);
  });

  it("returns typed MergeConflictError on merge conflicts", async () => {
    const conflictFile = join(repoDir, "conflict.txt");
    writeFileSync(conflictFile, "base\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add conflict file"], {
      cwd: repoDir,
    });

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    writeFileSync(conflictFile, "feature change\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature change"], {
      cwd: repoDir,
    });

    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
    writeFileSync(conflictFile, "main change\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "main change"], {
      cwd: repoDir,
    });

    execFileSync("git", ["checkout", "feature"], { cwd: repoDir });

    await expect(mergeToBase(repoDir, { baseRef: "main" })).rejects.toBeInstanceOf(
      MergeConflictError,
    );
  });

  it("uses stored baseRefName for Paseo worktrees (no heuristics)", async () => {
    // Create a non-default base branch with a unique commit.
    execFileSync("git", ["checkout", "-b", "develop"], { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "develop\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "develop change"], {
      cwd: repoDir,
    });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });

    // Create a worktree/branch based on develop, but keep main as the repo default.
    const worktree = await createLegacyWorktreeForTest({
      branchName: "feature",
      cwd: repoDir,
      baseBranch: "develop",
      worktreeSlug: "feature",
      paseoHome,
    });

    writeFileSync(join(worktree.worktreePath, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: worktree.worktreePath });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature commit"], {
      cwd: worktree.worktreePath,
    });

    const status = await getCheckoutStatus(worktree.worktreePath, { paseoHome });
    expect(status.isGit).toBe(true);
    expect(status.baseRef).toBe("develop");
    expect(status.aheadBehind?.ahead).toBe(1);

    const baseDiff = await getCheckoutDiff(worktree.worktreePath, { mode: "base" }, { paseoHome });
    expect(baseDiff.diff).toContain("feature.txt");
    expect(baseDiff.diff).not.toContain("file.txt");
  });

  it("excludes dirty working tree changes from Paseo worktree base diffs", async () => {
    const worktree = await createLegacyWorktreeForTest({
      branchName: "feature",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "dirty-feature",
      paseoHome,
    });

    writeFileSync(join(worktree.worktreePath, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: worktree.worktreePath });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature commit"], {
      cwd: worktree.worktreePath,
    });

    writeFileSync(join(worktree.worktreePath, "file.txt"), "dirty\n");
    writeFileSync(join(worktree.worktreePath, "untracked.txt"), "untracked\n");

    const baseDiff = await getCheckoutDiff(
      worktree.worktreePath,
      { mode: "base", includeStructured: true },
      { paseoHome },
    );

    expect(baseDiff.diff).toContain("feature.txt");
    expect(baseDiff.diff).not.toContain("file.txt");
    expect(baseDiff.diff).not.toContain("untracked.txt");
    expect(baseDiff.structured?.map((file) => file.path)).toEqual(["feature.txt"]);
  });

  it("resolves the repository default branch from origin HEAD", async () => {
    execFileSync("git", ["checkout", "-b", "develop"], { cwd: repoDir });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/repo.git"], {
      cwd: repoDir,
    });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "refs/heads/main"], {
      cwd: repoDir,
    });
    execFileSync("git", ["update-ref", "refs/remotes/origin/develop", "refs/heads/develop"], {
      cwd: repoDir,
    });
    execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], {
      cwd: repoDir,
    });

    await expect(resolveRepositoryDefaultBranch(repoDir)).resolves.toBe("main");
  });

  it("merges to stored baseRefName when baseRef is not provided", async () => {
    // Create a non-default base branch with a unique commit.
    execFileSync("git", ["checkout", "-b", "develop"], { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "develop\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "develop change"], {
      cwd: repoDir,
    });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });

    // Create a Paseo worktree configured to use develop as base.
    const worktree = await createLegacyWorktreeForTest({
      branchName: "feature",
      cwd: repoDir,
      baseBranch: "develop",
      worktreeSlug: "merge-to-develop",
      paseoHome,
    });

    writeFileSync(join(worktree.worktreePath, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: worktree.worktreePath });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature commit"], {
      cwd: worktree.worktreePath,
    });
    const featureCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree.worktreePath })
      .toString()
      .trim();

    // No baseRef passed: should merge into the configured base (develop), not default/main.
    await mergeToBase(worktree.worktreePath, {}, { paseoHome });

    execFileSync("git", ["merge-base", "--is-ancestor", featureCommit, "develop"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    expect(() =>
      execFileSync("git", ["merge-base", "--is-ancestor", featureCommit, "main"], {
        cwd: repoDir,
        stdio: "pipe",
      }),
    ).toThrow();
  });

  it("falls back to the repository default branch for base-dependent operations when metadata is missing", async () => {
    const worktree = await createLegacyWorktreeForTest({
      branchName: "feature-default-base",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "missing-metadata",
      paseoHome,
    });

    writeFileSync(join(worktree.worktreePath, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: worktree.worktreePath });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature commit"], {
      cwd: worktree.worktreePath,
    });

    const metadataPath = getPaseoWorktreeMetadataPath(worktree.worktreePath);
    rmSync(metadataPath, { force: true });

    const baseDiff = await getCheckoutDiff(worktree.worktreePath, { mode: "base" }, { paseoHome });
    expect(baseDiff.diff).toContain("feature.txt");

    const shortstat = await getCheckoutShortstat(worktree.worktreePath, { paseoHome });
    expect(shortstat).toEqual({ additions: 1, deletions: 0 });
  });

  it("falls back to plain git checkout status when Paseo worktree metadata is missing", async () => {
    const worktree = await createLegacyWorktreeForTest({
      branchName: "feature",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "missing-metadata-status-fallback",
      paseoHome,
    });

    const metadataPath = getPaseoWorktreeMetadataPath(worktree.worktreePath);
    rmSync(metadataPath, { force: true });

    const status = await getCheckoutStatus(worktree.worktreePath, { paseoHome });
    expect(status.isGit).toBe(true);
    expect(status.currentBranch).toBe("feature");
    expect(realpathSync.native(status.repoRoot)).toBe(realpathSync.native(worktree.worktreePath));
    expect(status.isPaseoOwnedWorktree).toBe(true);
    expect(realpathSync.native(status.mainRepoRoot ?? "")).toBe(realpathSync.native(repoDir));
    expect(status.baseRef).toBe("main");
  });

  describe("parseWorktreeList", () => {
    it("parses porcelain worktree output", () => {
      const output = [
        "worktree /home/user/repo",
        "branch refs/heads/main",
        "",
        "worktree /home/user/.paseo/worktrees/feature",
        "branch refs/heads/feature",
        "",
      ].join("\n");

      const entries = parseWorktreeList(output);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ path: "/home/user/repo", branchRef: "refs/heads/main" });
      expect(entries[1]).toEqual({
        path: "/home/user/.paseo/worktrees/feature",
        branchRef: "refs/heads/feature",
      });
    });

    it("detects bare repos", () => {
      const output = ["worktree /home/user/repo.git", "bare", ""].join("\n");
      const entries = parseWorktreeList(output);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.isBare).toBe(true);
    });
  });

  describe("isPaseoWorktreePath", () => {
    it("matches Unix .paseo/worktrees/ paths", () => {
      expect(isPaseoWorktreePath("/home/user/.paseo/worktrees/feature")).toBe(true);
    });

    it("matches Windows .paseo\\worktrees\\ paths", () => {
      expect(isPaseoWorktreePath("C:\\Users\\dev\\.paseo\\worktrees\\feature")).toBe(true);
    });

    it("rejects paths without .paseo/worktrees segment", () => {
      expect(isPaseoWorktreePath("/home/user/repo")).toBe(false);
      expect(isPaseoWorktreePath("C:\\Users\\dev\\repo")).toBe(false);
    });
  });

  describe("isDescendantPath", () => {
    it("detects children with Unix separators", () => {
      expect(isDescendantPath("/home/user/repo/child", "/home/user/repo")).toBe(true);
    });

    it("detects children with Windows separators", () => {
      expect(isDescendantPath("C:\\repos\\child", "C:\\repos")).toBe(true);
    });

    it("rejects the parent itself", () => {
      expect(isDescendantPath("/home/user/repo", "/home/user/repo")).toBe(false);
    });

    it("rejects siblings that share a prefix", () => {
      expect(isDescendantPath("/home/user/repo-extra", "/home/user/repo")).toBe(false);
    });

    it("handles mixed separators", () => {
      expect(isDescendantPath("C:/repo/child", "C:\\repo")).toBe(true);
    });

    it("is case insensitive on Windows paths", () => {
      expect(isDescendantPath("c:\\repo\\child", "C:\\repo")).toBe(true);
    });
  });
});
