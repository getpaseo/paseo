import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync, mkdirSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  commitAll,
  getCheckoutDiff,
  getPullRequestStatus,
  getCheckoutStatus,
  getCheckoutStatusLite,
  listBranchSuggestions,
  mergeToBase,
  mergeFromBase,
  MergeConflictError,
  MergeFromBaseConflictError,
  NotGitRepoError,
  pushCurrentBranch,
} from "./checkout-git.js";
import { createWorktree } from "./worktree.js";
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

describe("checkout git utilities", () => {
  let tempDir: string;
  let repoDir: string;
  let paseoHome: string;

  beforeEach(() => {
    const setup = initRepo();
    tempDir = setup.tempDir;
    repoDir = setup.repoDir;
    paseoHome = join(tempDir, "paseo-home");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws NotGitRepoError for non-git directories", async () => {
    const nonGitDir = join(tempDir, "not-git");
    execSync(`mkdir -p ${nonGitDir}`);

    await expect(
      getCheckoutDiff(nonGitDir, { mode: "uncommitted" })
    ).rejects.toBeInstanceOf(NotGitRepoError);
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
    const message = execSync("git log -1 --pretty=%B", { cwd: repoDir })
      .toString()
      .trim();
    expect(message).toBe("update file");
  });

  it("returns lightweight checkout status for normal repos", async () => {
    const status = await getCheckoutStatusLite(repoDir);
    expect(status.isGit).toBe(true);
    expect(status.currentBranch).toBe("main");
    expect(status.isPaseoOwnedWorktree).toBe(false);
    expect(status.mainRepoRoot).toBeNull();
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

  it("commits messages with quotes safely", async () => {
    const message = `He said "hello" and it's fine`;
    writeFileSync(join(repoDir, "file.txt"), "quoted\n");

    await commitAll(repoDir, message);

    const logMessage = execSync("git log -1 --pretty=%B", { cwd: repoDir })
      .toString()
      .trim();
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
      true
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
    const result = await createWorktree({
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

  it("returns lightweight checkout status for .paseo worktrees", async () => {
    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "lite-alpha",
      paseoHome,
    });

    const status = await getCheckoutStatusLite(result.worktreePath, { paseoHome });
    expect(status.isGit).toBe(true);
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

    const worktree = await createWorktree({
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
    const worktree = await createWorktree({
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
    const remoteOnlyCommit = execSync("git rev-parse HEAD", { cwd: otherClone })
      .toString()
      .trim();
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
    const localOnlyCommit = execSync("git rev-parse HEAD", { cwd: repoDir })
      .toString()
      .trim();

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
      mergeFromBase(repoDir, { baseRef: "main", requireCleanTarget: true })
    ).rejects.toBeInstanceOf(MergeFromBaseConflictError);

    const porcelain = execSync("git status --porcelain", { cwd: repoDir }).toString().trim();
    expect(porcelain).toBe("");
    expect(() => execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: repoDir })).toThrow();
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

    const fakeBinDir = join(tempDir, "fake-bin");
    mkdirSync(fakeBinDir);
    const gitPath = execSync("command -v git", { stdio: "pipe" }).toString().trim();
    symlinkSync(gitPath, join(fakeBinDir, "git"));

    const originalPath = process.env.PATH;
    process.env.PATH = fakeBinDir;
    try {
      const status = await getPullRequestStatus(repoDir);
      expect(status.githubFeaturesEnabled).toBe(false);
      expect(status.status).toBeNull();
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it("returns merged PR status when no open PR exists for the current branch", async () => {
    execSync("git checkout -b feature", { cwd: repoDir });
    execSync("git remote add origin https://github.com/getpaseo/paseo.git", { cwd: repoDir });

    const fakeBinDir = join(tempDir, "fake-bin-gh-merged");
    mkdirSync(fakeBinDir);
    const gitPath = execSync("command -v git", { stdio: "pipe" }).toString().trim();
    symlinkSync(gitPath, join(fakeBinDir, "git"));
    writeFileSync(
      join(fakeBinDir, "gh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "if [[ \"${1-}\" == \"--version\" ]]; then",
        "  echo \"gh version 2.0.0\"",
        "  exit 0",
        "fi",
        "args=\"$*\"",
        "if [[ \"$args\" == *\"state=open\"* ]]; then",
        "  echo \"[]\"",
        "  exit 0",
        "fi",
        "if [[ \"$args\" == *\"state=closed\"* ]]; then",
        "  echo '[{\"html_url\":\"https://github.com/getpaseo/paseo/pull/123\",\"title\":\"Ship feature\",\"state\":\"closed\",\"merged_at\":\"2026-02-18T00:00:00Z\",\"base\":{\"ref\":\"main\"},\"head\":{\"ref\":\"feature\"}}]'",
        "  exit 0",
        "fi",
        "echo \"unexpected gh args: $args\" >&2",
        "exit 1",
        "",
      ].join("\n"),
      "utf8"
    );
    execSync(`chmod +x ${join(fakeBinDir, "gh")}`);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
    try {
      const status = await getPullRequestStatus(repoDir);
      expect(status.githubFeaturesEnabled).toBe(true);
      expect(status.status).not.toBeNull();
      expect(status.status?.url).toContain("/pull/123");
      expect(status.status?.baseRefName).toBe("main");
      expect(status.status?.headRefName).toBe("feature");
      expect(status.status?.isMerged).toBe(true);
      expect(status.status?.state).toBe("merged");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it("does not treat closed-unmerged PRs as shipped status", async () => {
    execSync("git checkout -b feature", { cwd: repoDir });
    execSync("git remote add origin https://github.com/getpaseo/paseo.git", { cwd: repoDir });

    const fakeBinDir = join(tempDir, "fake-bin-gh-closed");
    mkdirSync(fakeBinDir);
    const gitPath = execSync("command -v git", { stdio: "pipe" }).toString().trim();
    symlinkSync(gitPath, join(fakeBinDir, "git"));
    writeFileSync(
      join(fakeBinDir, "gh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "if [[ \"${1-}\" == \"--version\" ]]; then",
        "  echo \"gh version 2.0.0\"",
        "  exit 0",
        "fi",
        "args=\"$*\"",
        "if [[ \"$args\" == *\"state=open\"* ]]; then",
        "  echo \"[]\"",
        "  exit 0",
        "fi",
        "if [[ \"$args\" == *\"state=closed\"* ]]; then",
        "  echo '[{\"html_url\":\"https://github.com/getpaseo/paseo/pull/999\",\"title\":\"Closed without merge\",\"state\":\"closed\",\"merged_at\":null,\"base\":{\"ref\":\"main\"},\"head\":{\"ref\":\"feature\"}}]'",
        "  exit 0",
        "fi",
        "echo \"unexpected gh args: $args\" >&2",
        "exit 1",
        "",
      ].join("\n"),
      "utf8"
    );
    execSync(`chmod +x ${join(fakeBinDir, "gh")}`);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
    try {
      const status = await getPullRequestStatus(repoDir);
      expect(status.githubFeaturesEnabled).toBe(true);
      expect(status.status).toBeNull();
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
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

    await expect(
      mergeToBase(repoDir, { baseRef: "main" })
    ).rejects.toBeInstanceOf(MergeConflictError);
  });

  it("uses stored baseRefName for Paseo worktrees (no heuristics)", async () => {
    // Create a non-default base branch with a unique commit.
    execSync("git checkout -b develop", { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "develop\n");
    execSync("git add file.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'develop change'", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });

    // Create a worktree/branch based on develop, but keep main as the repo default.
    const worktree = await createWorktree({
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

  it("merges to stored baseRefName when baseRef is not provided", async () => {
    // Create a non-default base branch with a unique commit.
    execSync("git checkout -b develop", { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "develop\n");
    execSync("git add file.txt", { cwd: repoDir });
    execSync("git -c commit.gpgsign=false commit -m 'develop change'", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });

    // Create a Paseo worktree configured to use develop as base.
    const worktree = await createWorktree({
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
      })
    ).toThrow();
  });

  it("throws if Paseo worktree base metadata is missing", async () => {
    const worktree = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "missing-metadata",
      paseoHome,
    });

    const metadataPath = getPaseoWorktreeMetadataPath(worktree.worktreePath);
    rmSync(metadataPath, { force: true });

    await expect(getCheckoutStatus(worktree.worktreePath, { paseoHome })).rejects.toThrow(
      /base/i
    );
    await expect(getCheckoutDiff(worktree.worktreePath, { mode: "base" }, { paseoHome })).rejects.toThrow(
      /base/i
    );
    await expect(mergeToBase(worktree.worktreePath, {}, { paseoHome })).rejects.toThrow(/base/i);
  });
});
