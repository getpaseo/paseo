import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { listCheckoutCommits } from "./checkout-git.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "checkout-commits-test-")));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd?: string): void {
  execFileSync("git", args, cwd ? { cwd } : {});
}

function commit(repoDir: string, message: string): void {
  git(["-c", "commit.gpgsign=false", "commit", "-m", message], repoDir);
}

function commitFile(repoDir: string, name: string, content: string, message: string): void {
  writeFileSync(join(repoDir, name), content);
  git(["add", "."], repoDir);
  commit(repoDir, message);
}

function initRepoOnMain(): { repoDir: string; tempDir: string } {
  const tempDir = makeTempDir();
  const repoDir = join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "test@test.com"], repoDir);
  git(["config", "user.name", "Test User"], repoDir);
  commitFile(repoDir, "README.md", "base\n", "initial");
  return { repoDir, tempDir };
}

function addBareRemote(repoDir: string, tempDir: string): string {
  const remoteDir = join(tempDir, "remote.git");
  git(["init", "--bare", "-b", "main", remoteDir]);
  git(["remote", "add", "origin", remoteDir], repoDir);
  return remoteDir;
}

describe("listCheckoutCommits", () => {
  it("lists commits ahead of base newest-first with on-remote flags and file stats", async () => {
    const { repoDir, tempDir } = initRepoOnMain();
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "foo.txt", "a\nb\nc\n", "Add foo");

    // Push feature (containing only commit A) to the remote, then add B locally.
    addBareRemote(repoDir, tempDir);
    git(["push", "-u", "origin", "feature"], repoDir);
    commitFile(repoDir, "bar.txt", "x\n", "Add bar");

    const { baseRef, commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(baseRef).toBe("main");
    expect(commits).toHaveLength(2);
    expect(commits[0]?.subject).toBe("Add bar");
    expect(commits[1]?.subject).toBe("Add foo");

    expect(commits[0]?.isOnRemote).toBe(false);
    expect(commits[1]?.isOnRemote).toBe(true);

    expect(commits[0]?.files).toEqual([
      { path: "bar.txt", additions: 1, deletions: 0, status: "added" },
    ]);
    expect(commits[1]?.files).toEqual([
      { path: "foo.txt", additions: 3, deletions: 0, status: "added" },
    ]);

    expect(commits[0]?.authorName).toBe("Test User");
    expect(commits[0]?.sha).toHaveLength(40);
    expect((commits[0]?.shortSha.length ?? 0) > 0).toBe(true);
    expect(Number.isNaN(new Date(commits[0]?.authorDate ?? "").getTime())).toBe(false);
  });

  it("returns [] when there are no commits ahead of base", async () => {
    const { repoDir } = initRepoOnMain();
    const { baseRef, commits } = await listCheckoutCommits({ cwd: repoDir });
    expect(baseRef).toBeNull();
    expect(commits).toEqual([]);
  });

  it("marks all commits local-only when there is no remote", async () => {
    const { repoDir } = initRepoOnMain();
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "foo.txt", "a\n", "Add foo");
    commitFile(repoDir, "bar.txt", "b\n", "Add bar");

    const { baseRef, commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(baseRef).toBe("main");
    expect(commits).toHaveLength(2);
    expect(commits.every((c) => c.isOnRemote === false)).toBe(true);
  });

  it("classifies renamed files with status renamed and correct destination path", async () => {
    const { repoDir } = initRepoOnMain();
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "original.txt", "content\n", "Add original");
    git(["mv", "original.txt", "renamed.txt"], repoDir);
    commit(repoDir, "Rename file");

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits[0]?.files).toEqual([
      { path: "renamed.txt", additions: 0, deletions: 0, status: "renamed" },
    ]);
  });

  it("derives status for modified and deleted files", async () => {
    const { repoDir } = initRepoOnMain();
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "README.md", "base\nmore\n", "Edit readme");
    git(["rm", "README.md"], repoDir);
    commit(repoDir, "Delete readme");

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits[0]?.files).toEqual([
      { path: "README.md", additions: 0, deletions: 2, status: "deleted" },
    ]);
    expect(commits[1]?.files).toEqual([
      { path: "README.md", additions: 1, deletions: 0, status: "modified" },
    ]);
  });
});
