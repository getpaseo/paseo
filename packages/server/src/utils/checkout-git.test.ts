import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "fs";
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
  listBranchSuggestions,
  mergeToBase,
  mergeFromBase,
  MergeConflictError,
  MergeFromBaseConflictError,
  NotGitRepoError,
  pullCurrentBranch,
  pushCurrentBranch,
  resolveRepositoryDefaultBranch,
  parseWorktreeList,
  parseStatusCheckRollup,
  isPaseoWorktreePath,
  isDescendantPath,
  searchGitHubIssuesAndPrs,
  warmCheckoutShortstatInBackground,
} from "./checkout-git.js";
import {
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
      newBranchName: options.branchName,
    },
    runSetup: options.runSetup ?? true,
    paseoHome: options.paseoHome,
  });
}
import { getPaseoWorktreeMetadataPath } from "./worktree-metadata.js";

function initRepo(): { tempDir: string; repoDir: string } {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "checkout-git-test-")));
  const repoDir = join(tempDir, "repo");
  execSync(`mkdir -p ${repoDir}`);
  execSync("git init -b main", { cwd: repoDir });
  execSync("git config user.email 'test@test.com'", { cwd: repoDir });
  execSync("git config user.name 'Test'", { cwd: repoDir });
  writeFileSync(join(repoDir, "file.txt"), "hello\n");
  execSync("git add .", { cwd: repoDir });
  execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir });
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
    execSync(`mkdir -p ${nonGitDir}`);

    await expect(getCheckoutDiff(nonGitDir, { mode: "uncommitted" })).rejects.toBeInstanceOf(
      NotGitRepoError,
    );
  });

  it("returns null for getCurrentBranch in a repo with no commits", async () => {
    const emptyRepo = join(tempDir, "empty-repo");
    execSync(`mkdir -p ${emptyRepo}`);
    execSync("git init -b main", { cwd: emptyRepo });

    const branch = await getCurrentBranch(emptyRepo);
    expect(branch).toBeNull();
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
    const message = execSync("git log -1 --pretty=%B", { cwd: repoDir }).toString().trim();
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
    execSync("git add example.ts", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'add multiline comment fixture'", {
      cwd: repoDir,
    });

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
    expect(status.repoRoot).toBe(repoDir);
    expect(status.isPaseoOwnedWorktree).toBe(false);
    expect(status.mainRepoRoot ?? null).toBeNull();
  });

  it("exposes hasRemote when origin is configured", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execSync(`git init --bare -b main ${remoteDir}`);
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });

    const status = await getCheckoutStatus(repoDir);
    expect(status.isGit).toBe(true);
    if (status.isGit) {
      expect(status.hasRemote).toBe(true);
    }
  });

  it("reports ahead/behind relative to origin on the base branch", async () => {
    const remoteDir = join(tempDir, "remote.git");
    const cloneDir = join(tempDir, "clone");
    execSync(`git init --bare -b main ${remoteDir}`);
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync("git push -u origin main", { cwd: repoDir });

    execSync(`git clone ${remoteDir} ${cloneDir}`);
    execSync("git config user.email 'test@test.com'", { cwd: cloneDir });
    execSync("git config user.name 'Test'", { cwd: cloneDir });
    writeFileSync(join(cloneDir, "file.txt"), "remote\n");
    execSync("git add file.txt", { cwd: cloneDir });
    execSync("git -c commit.gpgsign=false commit -m 'remote update'", { cwd: cloneDir });
    execSync("git push", { cwd: cloneDir });

    execSync("git fetch origin", { cwd: repoDir });
    const behindStatus = await getCheckoutStatus(repoDir);
    expect(behindStatus.isGit).toBe(true);
    if (!behindStatus.isGit) {
      return;
    }
    expect(behindStatus.aheadOfOrigin).toBe(0);
    expect(behindStatus.behindOfOrigin).toBe(1);

    writeFileSync(join(repoDir, "local.txt"), "local\n");
    execSync("git add local.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'local update'", { cwd: repoDir });

    const divergedStatus = await getCheckoutStatus(repoDir);
    expect(divergedStatus.isGit).toBe(true);
    if (!divergedStatus.isGit) {
      return;
    }
    expect(divergedStatus.aheadOfOrigin).toBe(1);
    expect(divergedStatus.behindOfOrigin).toBe(1);
  });

  it("uses the freshest comparison base for status and shortstat when local main is stale", async () => {
    const remoteDir = join(tempDir, "remote.git");
    const cloneDir = join(tempDir, "clone");
    execSync(`git init --bare -b main ${remoteDir}`);
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync("git push -u origin main", { cwd: repoDir });

    execSync(`git clone ${remoteDir} ${cloneDir}`);
    execSync("git config user.email 'test@test.com'", { cwd: cloneDir });
    execSync("git config user.name 'Test'", { cwd: cloneDir });
    writeFileSync(join(cloneDir, "upstream.txt"), "upstream 1\nupstream 2\n");
    execSync("git add upstream.txt", { cwd: cloneDir });
    execSync("git -c commit.gpgsign=false commit -m 'remote update'", { cwd: cloneDir });
    execSync("git push", { cwd: cloneDir });

    execSync("git fetch origin", { cwd: repoDir });
    execSync("git checkout -b feature origin/main", { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execSync("git add feature.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'feature update'", { cwd: repoDir });

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

    const logMessage = execSync("git log -1 --pretty=%B", { cwd: repoDir }).toString().trim();
    expect(logMessage).toBe(message);
  });

  it("diffs base mode against merge-base (no base-only deletions)", async () => {
    execSync("git checkout -b feature", { cwd: repoDir });

    // Advance base branch after feature splits off.
    execSync("git checkout main", { cwd: repoDir });
    writeFileSync(join(repoDir, "base-only.txt"), "base\n");
    execSync("git add base-only.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'base only'", { cwd: repoDir });

    // Make a feature change.
    execSync("git checkout feature", { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execSync("git add feature.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'feature commit'", { cwd: repoDir });

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
    execSync("git add tracked-blob.bin", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'add tracked binary'", {
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
    expect(status.repoRoot).toBe(result.worktreePath);
    expect(status.isDirty).toBe(true);
    expect(status.isPaseoOwnedWorktree).toBe(true);
    expect(status.mainRepoRoot).toBe(repoDir);

    const diff = await getCheckoutDiff(result.worktreePath, { mode: "uncommitted" }, { paseoHome });
    expect(diff.diff).toContain("-hello");
    expect(diff.diff).toContain("+worktree change");

    await commitAll(result.worktreePath, "worktree update");

    const cleanStatus = await getCheckoutStatus(result.worktreePath, { paseoHome });
    expect(cleanStatus.isDirty).toBe(false);
    const message = execSync("git log -1 --pretty=%B", {
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
    expect(status.repoRoot).toBe(result.worktreePath);
    expect(status.isPaseoOwnedWorktree).toBe(true);
    expect(status.mainRepoRoot).toBe(repoDir);
  });

  it("returns mainRepoRoot pointing to first non-bare worktree for bare repos", async () => {
    const bareRepoDir = join(tempDir, "bare-repo");
    execSync(`git clone --bare ${repoDir} ${bareRepoDir}`);

    const mainCheckoutDir = join(tempDir, "main-checkout");
    execSync(`git -C ${bareRepoDir} worktree add ${mainCheckoutDir} main`);
    execSync("git config user.email 'test@test.com'", { cwd: mainCheckoutDir });
    execSync("git config user.name 'Test'", { cwd: mainCheckoutDir });

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
    expect(status.mainRepoRoot).toBe(mainCheckoutDir);
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
    execSync("git checkout -b feature", { cwd: worktree.worktreePath });
    execSync("git add merge.txt", { cwd: worktree.worktreePath });
    execSync("git -c commit.gpgsign=false commit -m 'feature commit'", {
      cwd: worktree.worktreePath,
    });
    const featureCommit = execSync("git rev-parse HEAD", { cwd: worktree.worktreePath })
      .toString()
      .trim();

    await mergeToBase(worktree.worktreePath, { baseRef: "main" }, { paseoHome });

    const baseContainsFeature = execSync(`git merge-base --is-ancestor ${featureCommit} main`, {
      cwd: repoDir,
      stdio: "pipe",
    });
    expect(baseContainsFeature).toBeDefined();

    const statusAfterMerge = await getCheckoutStatus(worktree.worktreePath, { paseoHome });
    expect(statusAfterMerge.isGit).toBe(true);
    if (statusAfterMerge.isGit) {
      expect(statusAfterMerge.aheadBehind?.ahead ?? 0).toBe(0);
    }

    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: worktree.worktreePath,
    })
      .toString()
      .trim();
    expect(currentBranch).toBe("feature");
  });

  it("merges from the most-ahead base ref (origin/main when it is ahead)", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execSync(`git init --bare -b main ${remoteDir}`);
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync("git push -u origin main", { cwd: repoDir });

    // Advance origin/main without advancing local main.
    const otherClone = join(tempDir, "other-clone");
    execSync(`git clone ${remoteDir} ${otherClone}`);
    execSync("git config user.email 'test@test.com'", { cwd: otherClone });
    execSync("git config user.name 'Test'", { cwd: otherClone });
    writeFileSync(join(otherClone, "remote-only.txt"), "remote\n");
    execSync("git add remote-only.txt", { cwd: otherClone });
    execSync("git -c commit.gpgsign=false commit -m 'remote only'", { cwd: otherClone });
    const remoteOnlyCommit = execSync("git rev-parse HEAD", { cwd: otherClone }).toString().trim();
    execSync("git push", { cwd: otherClone });
    execSync("git fetch origin", { cwd: repoDir });

    execSync("git checkout -b feature", { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execSync("git add feature.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'feature commit'", { cwd: repoDir });

    await mergeFromBase(repoDir, { baseRef: "main", requireCleanTarget: true });

    execSync(`git merge-base --is-ancestor ${remoteOnlyCommit} feature`, { cwd: repoDir });
  });

  it("merges from the most-ahead base ref (local main when it is ahead)", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execSync(`git init --bare -b main ${remoteDir}`);
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync("git push -u origin main", { cwd: repoDir });

    // Advance local main without pushing.
    writeFileSync(join(repoDir, "local-only.txt"), "local\n");
    execSync("git add local-only.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'local only'", { cwd: repoDir });
    const localOnlyCommit = execSync("git rev-parse HEAD", { cwd: repoDir }).toString().trim();

    execSync(`git checkout -b feature ${localOnlyCommit}~1`, { cwd: repoDir });
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execSync("git add feature.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'feature commit'", { cwd: repoDir });

    await mergeFromBase(repoDir, { baseRef: "main", requireCleanTarget: true });

    execSync(`git merge-base --is-ancestor ${localOnlyCommit} feature`, { cwd: repoDir });
  });

  it("aborts merge-from-base on conflicts and leaves no merge in progress", async () => {
    writeFileSync(join(repoDir, "conflict.txt"), "base\n");
    execSync("git add conflict.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'add conflict file'", { cwd: repoDir });

    execSync("git checkout -b feature", { cwd: repoDir });
    writeFileSync(join(repoDir, "conflict.txt"), "feature\n");
    execSync("git add conflict.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'feature change'", { cwd: repoDir });

    execSync("git checkout main", { cwd: repoDir });
    writeFileSync(join(repoDir, "conflict.txt"), "main change\n");
    execSync("git add conflict.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'main change'", { cwd: repoDir });

    execSync("git checkout feature", { cwd: repoDir });

    await expect(
      mergeFromBase(repoDir, { baseRef: "main", requireCleanTarget: true }),
    ).rejects.toBeInstanceOf(MergeFromBaseConflictError);

    const porcelain = execSync("git status --porcelain", { cwd: repoDir }).toString().trim();
    expect(porcelain).toBe("");
    expect(() => execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: repoDir })).toThrow();
  });

  it("pulls the current branch from origin", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execSync(`git init --bare -b main ${remoteDir}`);
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync("git push -u origin main", { cwd: repoDir });

    const otherClone = join(tempDir, "other-clone");
    execSync(`git clone ${remoteDir} ${otherClone}`);
    execSync("git config user.email 'test@test.com'", { cwd: otherClone });
    execSync("git config user.name 'Test'", { cwd: otherClone });
    writeFileSync(join(otherClone, "pulled.txt"), "remote\n");
    execSync("git add pulled.txt", { cwd: otherClone });
    execSync("git -c commit.gpgsign=false commit -m 'remote pull commit'", { cwd: otherClone });
    const remoteCommit = execSync("git rev-parse HEAD", { cwd: otherClone }).toString().trim();
    execSync("git push", { cwd: otherClone });

    await pullCurrentBranch(repoDir);

    execSync(`git merge-base --is-ancestor ${remoteCommit} HEAD`, { cwd: repoDir });
    expect(readFileSync(join(repoDir, "pulled.txt"), "utf8")).toBe("remote\n");
  });

  it("aborts pull on merge conflicts and leaves no merge in progress", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execSync(`git init --bare -b main ${remoteDir}`);
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync("git push -u origin main", { cwd: repoDir });

    writeFileSync(join(repoDir, "conflict.txt"), "local\n");
    execSync("git add conflict.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'local conflict commit'", { cwd: repoDir });

    const otherClone = join(tempDir, "other-clone");
    execSync(`git clone ${remoteDir} ${otherClone}`);
    execSync("git config user.email 'test@test.com'", { cwd: otherClone });
    execSync("git config user.name 'Test'", { cwd: otherClone });
    writeFileSync(join(otherClone, "conflict.txt"), "remote\n");
    execSync("git add conflict.txt", { cwd: otherClone });
    execSync("git -c commit.gpgsign=false commit -m 'remote conflict commit'", { cwd: otherClone });
    execSync("git push", { cwd: otherClone });

    await expect(pullCurrentBranch(repoDir)).rejects.toBeInstanceOf(Error);

    const porcelain = execSync("git status --porcelain", { cwd: repoDir }).toString().trim();
    expect(porcelain).toBe("");
    expect(() => execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: repoDir })).toThrow();
  });

  it("aborts pull on rebase conflicts and leaves no rebase in progress", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execSync(`git init --bare -b main ${remoteDir}`);
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync("git push -u origin main", { cwd: repoDir });
    execSync("git config pull.rebase true", { cwd: repoDir });

    writeFileSync(join(repoDir, "conflict.txt"), "local\n");
    execSync("git add conflict.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'local rebase conflict commit'", {
      cwd: repoDir,
    });

    const otherClone = join(tempDir, "other-clone");
    execSync(`git clone ${remoteDir} ${otherClone}`);
    execSync("git config user.email 'test@test.com'", { cwd: otherClone });
    execSync("git config user.name 'Test'", { cwd: otherClone });
    writeFileSync(join(otherClone, "conflict.txt"), "remote\n");
    execSync("git add conflict.txt", { cwd: otherClone });
    execSync("git -c commit.gpgsign=false commit -m 'remote rebase conflict commit'", {
      cwd: otherClone,
    });
    execSync("git push", { cwd: otherClone });

    await expect(pullCurrentBranch(repoDir)).rejects.toBeInstanceOf(Error);

    const gitDir = execSync("git rev-parse --absolute-git-dir", { cwd: repoDir }).toString().trim();
    const porcelain = execSync("git status --porcelain", { cwd: repoDir }).toString().trim();
    expect(porcelain).toBe("");
    expect(existsSync(join(gitDir, "rebase-merge"))).toBe(false);
    expect(existsSync(join(gitDir, "rebase-apply"))).toBe(false);
  });

  it("pushes the current branch to origin", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execSync(`git init --bare -b main ${remoteDir}`);
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync("git push -u origin main", { cwd: repoDir });

    execSync("git checkout -b feature", { cwd: repoDir });
    writeFileSync(join(repoDir, "push.txt"), "push\n");
    execSync("git add push.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'push commit'", { cwd: repoDir });

    await pushCurrentBranch(repoDir);

    execSync(`git --git-dir ${remoteDir} show-ref --verify refs/heads/feature`);
  });

  it("lists merged local and remote branch suggestions without duplicates", async () => {
    const remoteDir = join(tempDir, "remote.git");
    execSync(`git init --bare -b main ${remoteDir}`);
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync("git push -u origin main", { cwd: repoDir });

    execSync("git checkout -b local-only", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });

    const otherClone = join(tempDir, "other-clone");
    execSync(`git clone ${remoteDir} ${otherClone}`);
    execSync("git config user.email 'test@test.com'", { cwd: otherClone });
    execSync("git config user.name 'Test'", { cwd: otherClone });
    execSync("git checkout -b remote-only", { cwd: otherClone });
    writeFileSync(join(otherClone, "remote-only.txt"), "remote-only\n");
    execSync("git add remote-only.txt", { cwd: otherClone });
    execSync("git -c commit.gpgsign=false commit -m 'remote only branch'", { cwd: otherClone });
    execSync("git push -u origin remote-only", { cwd: otherClone });
    execSync("git fetch origin", { cwd: repoDir });

    const branches = await listBranchSuggestions(repoDir, { limit: 50 });
    expect(branches).toContain("main");
    expect(branches).toContain("local-only");
    expect(branches).toContain("remote-only");
    expect(branches.filter((name) => name === "main")).toHaveLength(1);
    expect(branches).not.toContain("HEAD");
    expect(branches.some((name) => name.startsWith("origin/"))).toBe(false);
  });

  it("filters branch suggestions by query and enforces result limit", async () => {
    execSync("git checkout -b feature/alpha", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });
    execSync("git checkout -b feature/beta", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });
    execSync("git checkout -b chore/docs", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });

    const branches = await listBranchSuggestions(repoDir, {
      query: "FEATURE/",
      limit: 1,
    });
    expect(branches).toHaveLength(1);
    expect(branches[0]?.toLowerCase()).toContain("feature/");
  });

  it("disables GitHub features when gh is unavailable", async () => {
    execSync("git remote add origin https://github.com/getpaseo/paseo.git", { cwd: repoDir });

    const github = createGitHubServiceForStatus(null);
    github.getCurrentPullRequestStatus = async () => {
      throw new GitHubCliMissingError();
    };
    const status = await getPullRequestStatus(repoDir, github);
    expect(status.githubFeaturesEnabled).toBe(false);
    expect(status.status).toBeNull();
  });

  it("searches GitHub issues and PRs through the GitHub service", async () => {
    let issueCalls = 0;
    let pullRequestCalls = 0;
    const github = createGitHubServiceForStatus(null);
    github.listIssues = async (options) => {
      issueCalls += 1;
      expect(options).toEqual({ cwd: repoDir, query: "cache", limit: 5 });
      return [
        {
          number: 55,
          title: "Issue title",
          url: "https://github.com/getpaseo/paseo/issues/55",
          state: "OPEN",
          body: "issue body",
          labels: ["bug"],
        },
      ];
    };
    github.listPullRequests = async (options) => {
      pullRequestCalls += 1;
      expect(options).toEqual({ cwd: repoDir, query: "cache", limit: 5 });
      return [
        {
          number: 123,
          title: "PR title",
          url: "https://github.com/getpaseo/paseo/pull/123",
          state: "OPEN",
          body: "pr body",
          baseRefName: "main",
          headRefName: "feature",
          labels: ["enhancement"],
        },
      ];
    };

    const result = await searchGitHubIssuesAndPrs(repoDir, "cache", 5, github);

    expect(issueCalls).toBe(1);
    expect(pullRequestCalls).toBe(1);
    expect(result).toEqual({
      githubFeaturesEnabled: true,
      items: [
        {
          kind: "issue",
          number: 55,
          title: "Issue title",
          url: "https://github.com/getpaseo/paseo/issues/55",
          state: "OPEN",
          body: "issue body",
          labels: ["bug"],
          baseRefName: null,
          headRefName: null,
        },
        {
          kind: "pr",
          number: 123,
          title: "PR title",
          url: "https://github.com/getpaseo/paseo/pull/123",
          state: "OPEN",
          body: "pr body",
          labels: ["enhancement"],
          baseRefName: "main",
          headRefName: "feature",
        },
      ],
    });
  });

  it("searches only GitHub PRs when the search kinds request excludes issues", async () => {
    let issueCalls = 0;
    let pullRequestCalls = 0;
    const github = createGitHubServiceForStatus(null);
    github.listIssues = async () => {
      issueCalls += 1;
      return [];
    };
    github.listPullRequests = async (options) => {
      pullRequestCalls += 1;
      expect(options).toEqual({ cwd: repoDir, query: "cache", limit: 5 });
      return [
        {
          number: 123,
          title: "PR title",
          url: "https://github.com/getpaseo/paseo/pull/123",
          state: "OPEN",
          body: "pr body",
          baseRefName: "main",
          headRefName: "feature",
          labels: ["enhancement"],
        },
      ];
    };

    const result = await searchGitHubIssuesAndPrs(repoDir, "cache", 5, github, {
      kinds: ["github-pr"],
    });

    expect(issueCalls).toBe(0);
    expect(pullRequestCalls).toBe(1);
    expect(result).toEqual({
      githubFeaturesEnabled: true,
      items: [
        {
          kind: "pr",
          number: 123,
          title: "PR title",
          url: "https://github.com/getpaseo/paseo/pull/123",
          state: "OPEN",
          body: "pr body",
          labels: ["enhancement"],
          baseRefName: "main",
          headRefName: "feature",
        },
      ],
    });
  });

  it("parses real gh status check rollup output and dedupes by latest check run", () => {
    expect(
      parseStatusCheckRollup([
        {
          __typename: "CheckRun",
          completedAt: "2026-04-02T13:53:59Z",
          conclusion: "SUCCESS",
          detailsUrl: "https://github.com/org/repo/actions/runs/123",
          name: "review_app",
          startedAt: "2026-04-02T13:49:31Z",
          status: "COMPLETED",
          workflowName: "Deploy PR Preview",
        },
        {
          __typename: "CheckRun",
          completedAt: "2026-04-02T13:58:59Z",
          conclusion: "FAILURE",
          detailsUrl: "https://github.com/org/repo/actions/runs/124",
          name: "review_app",
          startedAt: "2026-04-02T13:55:31Z",
          status: "COMPLETED",
        },
      ]),
    ).toEqual([
      {
        name: "review_app",
        status: "failure",
        url: "https://github.com/org/repo/actions/runs/124",
      },
    ]);
  });

  it("parses mixed check run and status context entries", () => {
    expect(
      parseStatusCheckRollup([
        {
          __typename: "CheckRun",
          name: "unit-tests",
          status: "IN_PROGRESS",
          conclusion: null,
          detailsUrl: "https://github.com/org/repo/actions/runs/200",
          startedAt: "2026-04-02T13:49:31Z",
        },
        {
          __typename: "StatusContext",
          context: "lint",
          state: "SUCCESS",
          targetUrl: "https://github.com/org/repo/status/300",
          createdAt: "2026-04-02T13:48:00Z",
        },
      ]),
    ).toEqual([
      {
        name: "unit-tests",
        status: "pending",
        url: "https://github.com/org/repo/actions/runs/200",
      },
      {
        name: "lint",
        status: "success",
        url: "https://github.com/org/repo/status/300",
      },
    ]);
  });

  it("returns an empty list for nullish or empty status check rollups", () => {
    expect(parseStatusCheckRollup(undefined)).toEqual([]);
    expect(parseStatusCheckRollup(null)).toEqual([]);
    expect(parseStatusCheckRollup([])).toEqual([]);
  });

  it("ignores unknown status check rollup node types", () => {
    expect(
      parseStatusCheckRollup([
        {
          __typename: "Commit",
          oid: "abc123",
        },
        {
          __typename: "CheckRun",
          name: "build",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          detailsUrl: "https://github.com/org/repo/actions/runs/500",
        },
      ]),
    ).toEqual([
      {
        name: "build",
        status: "success",
        url: "https://github.com/org/repo/actions/runs/500",
      },
    ]);
  });

  it("returns merged PR status when no open PR exists for the current branch", async () => {
    execSync("git checkout -b feature", { cwd: repoDir });
    execSync("git remote add origin https://github.com/getpaseo/paseo.git", { cwd: repoDir });

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

  it("returns closed-unmerged PR status without marking it as merged", async () => {
    execSync("git checkout -b feature", { cwd: repoDir });
    execSync("git remote add origin https://github.com/getpaseo/paseo.git", { cwd: repoDir });

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
    execSync("git checkout -b feature", { cwd: repoDir });
    execSync("git remote add origin https://github.com/getpaseo/paseo.git", { cwd: repoDir });

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
    execSync("git checkout -b feature", { cwd: repoDir });
    execSync("git remote add origin https://github.com/getpaseo/paseo.git", { cwd: repoDir });

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

  it("dedupes concurrent PR status lookups for the same cwd", async () => {
    execSync("git checkout -b feature", { cwd: repoDir });
    execSync("git remote add origin https://github.com/getpaseo/paseo.git", { cwd: repoDir });

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
    execSync("git add conflict.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'add conflict file'", {
      cwd: repoDir,
    });

    execSync("git checkout -b feature", { cwd: repoDir });
    writeFileSync(conflictFile, "feature change\n");
    execSync("git add conflict.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'feature change'", {
      cwd: repoDir,
    });

    execSync("git checkout main", { cwd: repoDir });
    writeFileSync(conflictFile, "main change\n");
    execSync("git add conflict.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'main change'", {
      cwd: repoDir,
    });

    execSync("git checkout feature", { cwd: repoDir });

    await expect(mergeToBase(repoDir, { baseRef: "main" })).rejects.toBeInstanceOf(
      MergeConflictError,
    );
  });

  it("uses stored baseRefName for Paseo worktrees (no heuristics)", async () => {
    // Create a non-default base branch with a unique commit.
    execSync("git checkout -b develop", { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "develop\n");
    execSync("git add file.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'develop change'", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });

    // Create a worktree/branch based on develop, but keep main as the repo default.
    const worktree = await createLegacyWorktreeForTest({
      branchName: "feature",
      cwd: repoDir,
      baseBranch: "develop",
      worktreeSlug: "feature",
      paseoHome,
    });

    writeFileSync(join(worktree.worktreePath, "feature.txt"), "feature\n");
    execSync("git add feature.txt", { cwd: worktree.worktreePath });
    execSync("git -c commit.gpgsign=false commit -m 'feature commit'", {
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

  it("resolves the repository default branch from origin HEAD", async () => {
    execSync("git checkout -b develop", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });
    execSync("git remote add origin https://github.com/acme/repo.git", { cwd: repoDir });
    execSync("git update-ref refs/remotes/origin/main refs/heads/main", { cwd: repoDir });
    execSync("git update-ref refs/remotes/origin/develop refs/heads/develop", { cwd: repoDir });
    execSync("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: repoDir,
    });

    await expect(resolveRepositoryDefaultBranch(repoDir)).resolves.toBe("main");
  });

  it("merges to stored baseRefName when baseRef is not provided", async () => {
    // Create a non-default base branch with a unique commit.
    execSync("git checkout -b develop", { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "develop\n");
    execSync("git add file.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'develop change'", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });

    // Create a Paseo worktree configured to use develop as base.
    const worktree = await createLegacyWorktreeForTest({
      branchName: "feature",
      cwd: repoDir,
      baseBranch: "develop",
      worktreeSlug: "merge-to-develop",
      paseoHome,
    });

    writeFileSync(join(worktree.worktreePath, "feature.txt"), "feature\n");
    execSync("git add feature.txt", { cwd: worktree.worktreePath });
    execSync("git -c commit.gpgsign=false commit -m 'feature commit'", {
      cwd: worktree.worktreePath,
    });
    const featureCommit = execSync("git rev-parse HEAD", { cwd: worktree.worktreePath })
      .toString()
      .trim();

    // No baseRef passed: should merge into the configured base (develop), not default/main.
    await mergeToBase(worktree.worktreePath, {}, { paseoHome });

    execSync(`git merge-base --is-ancestor ${featureCommit} develop`, {
      cwd: repoDir,
      stdio: "pipe",
    });
    expect(() =>
      execSync(`git merge-base --is-ancestor ${featureCommit} main`, {
        cwd: repoDir,
        stdio: "pipe",
      }),
    ).toThrow();
  });

  it("throws if Paseo worktree base metadata is missing", async () => {
    const worktree = await createLegacyWorktreeForTest({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "missing-metadata",
      paseoHome,
    });

    const metadataPath = getPaseoWorktreeMetadataPath(worktree.worktreePath);
    rmSync(metadataPath, { force: true });

    await expect(getCheckoutStatus(worktree.worktreePath, { paseoHome })).rejects.toThrow(/base/i);
    await expect(
      getCheckoutDiff(worktree.worktreePath, { mode: "base" }, { paseoHome }),
    ).rejects.toThrow(/base/i);
    await expect(mergeToBase(worktree.worktreePath, {}, { paseoHome })).rejects.toThrow(/base/i);
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
