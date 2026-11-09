import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCommitFileDiff,
  listCheckoutCommits,
  getCheckoutStatus,
  getCheckoutDiff,
} from "./checkout-git.js";
import { writePaseoWorktreeMetadata } from "./worktree-metadata.js";

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
  git(
    ["-c", "commit.gpgsign=false", "commit", "--author=Test User <test@test.com>", "-m", message],
    repoDir,
  );
}

function commitFile(repoDir: string, name: string, content: string, message: string): void {
  writeFileSync(join(repoDir, name), content);
  git(["add", "."], repoDir);
  commit(repoDir, message);
}

function importLinearHistory({
  repoDir,
  branch,
  file,
  subject,
  count,
}: {
  repoDir: string;
  branch: string;
  file: string;
  subject: string;
  count: number;
}): void {
  const startingSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
  }).trim();
  const commands: string[] = [];
  let parent = startingSha;

  for (let index = 1; index <= count; index += 1) {
    const blobMark = index * 2 - 1;
    const commitMark = index * 2;
    const content = `${index}\n`;
    const message = `${subject} ${index}`;
    commands.push(
      `blob\nmark :${blobMark}\ndata ${Buffer.byteLength(content)}\n${content}`,
      `commit refs/heads/${branch}\nmark :${commitMark}\ncommitter Test User <test@test.com> ${1_700_000_000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${parent}\nM 100644 :${blobMark} ${file}\n\n`,
    );
    parent = `:${commitMark}`;
  }

  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: repoDir,
    input: commands.join(""),
  });
  git(["reset", "--hard", branch], repoDir);
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
  it("keeps fixture authors independent of command-scoped Git configuration", async () => {
    const overrides = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Other User",
    };
    const previous = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key]]),
    );
    let repoDir: string;
    try {
      Object.assign(process.env, overrides);
      ({ repoDir } = initRepoOnMain());
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const { commits } = await listCheckoutCommits({ cwd: repoDir });
    expect(commits[0]?.authorName).toBe("Test User");
  });

  it("lists recent commits newest-first with on-remote flags and file stats", async () => {
    const { repoDir, tempDir } = initRepoOnMain();
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "foo.txt", "a\nb\nc\n", "Add foo");

    // Push feature (containing only commit A) to the remote, then add B locally.
    addBareRemote(repoDir, tempDir);
    git(["push", "-u", "origin", "feature"], repoDir);
    commitFile(repoDir, "bar.txt", "x\n", "Add bar");

    const { baseRef, commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(baseRef).toBe("main");
    expect(commits).toHaveLength(3);
    expect(commits[0]?.subject).toBe("Add bar");
    expect(commits[1]?.subject).toBe("Add foo");
    expect(commits[2]?.subject).toBe("initial");

    expect(commits[0]?.isOnRemote).toBe(false);
    expect(commits[1]?.isOnRemote).toBe(true);
    expect(commits[2]?.isOnRemote).toBe(true);
    expect(commits[0]?.isOnBase).toBe(false);
    expect(commits[1]?.isOnBase).toBe(false);
    expect(commits[2]?.isOnBase).toBe(true);

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

  it("shows recent history on the base branch", async () => {
    const { repoDir } = initRepoOnMain();
    const { baseRef, commits } = await listCheckoutCommits({ cwd: repoDir });
    expect(baseRef).toBeNull();
    expect(commits.map((entry) => entry.subject)).toEqual(["initial"]);
    expect(commits[0]?.isOnBase).toBe(true);
  });

  it("keeps recent history when the saved base branch no longer exists", async () => {
    const { repoDir, tempDir } = initRepoOnMain();
    const worktreesRoot = join(tempDir, "worktrees");
    const worktreeDir = join(worktreesRoot, "repo-hash", "feature");
    mkdirSync(join(worktreesRoot, "repo-hash"), { recursive: true });
    git(["worktree", "add", "-b", "feature", worktreeDir], repoDir);
    commitFile(worktreeDir, "feature.txt", "feature\n", "Feature work");
    await writePaseoWorktreeMetadata(worktreeDir, { baseRefName: "deleted-base" });

    const { baseRef, commits } = await listCheckoutCommits({
      cwd: worktreeDir,
      context: { worktreesRoot },
    });

    expect(baseRef).toBe("main");
    expect(commits.map((entry) => entry.subject)).toEqual(["Feature work", "initial"]);
    expect(commits.map((entry) => entry.isOnBase)).toEqual([false, true]);
  });

  it("marks all commits local-only when there is no remote", async () => {
    const { repoDir } = initRepoOnMain();
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "foo.txt", "a\n", "Add foo");
    commitFile(repoDir, "bar.txt", "b\n", "Add bar");

    const { baseRef, commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(baseRef).toBe("main");
    expect(commits).toHaveLength(3);
    expect(commits.every((c) => c.isOnRemote === false)).toBe(true);
  });

  it("recognizes base history on a remote before the feature branch is pushed", async () => {
    const { repoDir, tempDir } = initRepoOnMain();
    addBareRemote(repoDir, tempDir);
    git(["push", "-u", "origin", "main"], repoDir);
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "feature.txt", "local\n", "Local feature");

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits.map(({ subject, isOnRemote }) => ({ subject, isOnRemote }))).toEqual([
      { subject: "Local feature", isOnRemote: false },
      { subject: "initial", isOnRemote: true },
    ]);
  });

  it("keeps local base commits out of workspace history when the local base is ahead", async () => {
    const { repoDir, tempDir } = initRepoOnMain();
    addBareRemote(repoDir, tempDir);
    git(["push", "-u", "origin", "main"], repoDir);
    commitFile(repoDir, "local-base.txt", "base\n", "Local base work");
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "feature.txt", "feature\n", "Feature work");

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits.map(({ subject, isOnBase }) => ({ subject, isOnBase }))).toEqual([
      { subject: "Feature work", isOnBase: false },
      { subject: "Local base work", isOnBase: true },
      { subject: "initial", isOnBase: true },
    ]);
  });

  it("shows every workspace commit followed by at most 10 base commits", async () => {
    const { repoDir } = initRepoOnMain();
    importLinearHistory({
      repoDir,
      branch: "main",
      file: "base-history.txt",
      subject: "Base",
      count: 14,
    });
    git(["checkout", "-b", "feature"], repoDir);
    importLinearHistory({
      repoDir,
      branch: "feature",
      file: "workspace-history.txt",
      subject: "Workspace",
      count: 24,
    });

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits).toHaveLength(34);
    expect(commits.every((entry) => entry.isOnRemote === false)).toBe(true);
    expect(commits.slice(0, 24).map((entry) => entry.subject)).toEqual(
      Array.from({ length: 24 }, (_, index) => `Workspace ${24 - index}`),
    );
    expect(commits.slice(0, 24).every((entry) => entry.isOnBase === false)).toBe(true);
    expect(commits.slice(24).map((entry) => entry.subject)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Base ${14 - index}`),
    );
    expect(commits.slice(24).every((entry) => entry.isOnBase === true)).toBe(true);
  });

  it("starts base context at the fork point when the base branch has advanced", async () => {
    const { repoDir } = initRepoOnMain();
    commitFile(repoDir, "shared.txt", "shared\n", "Shared base");
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "feature.txt", "feature\n", "Feature work");
    git(["checkout", "main"], repoDir);
    commitFile(repoDir, "newer-base.txt", "newer\n", "Newer base");
    git(["checkout", "feature"], repoDir);

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits.map(({ subject, isOnBase }) => ({ subject, isOnBase }))).toEqual([
      { subject: "Feature work", isOnBase: false },
      { subject: "Shared base", isOnBase: true },
      { subject: "initial", isOnBase: true },
    ]);
  });

  it("limits base-branch history to 10 commits", async () => {
    const { repoDir } = initRepoOnMain();
    importLinearHistory({
      repoDir,
      branch: "main",
      file: "history.txt",
      subject: "Commit",
      count: 14,
    });

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits.map((entry) => entry.subject)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Commit ${14 - index}`),
    );
    expect(commits.every((entry) => entry.isOnBase === true)).toBe(true);
  });

  it("shows merged branch commits and compares the merge against its first parent", async () => {
    const { repoDir } = initRepoOnMain();
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "feature.txt", "feature\n", "Add feature");
    git(["checkout", "main"], repoDir);
    commitFile(repoDir, "main.txt", "main\n", "Advance main");
    git(["merge", "--no-ff", "feature", "-m", "Merge feature"], repoDir);

    const { commits } = await listCheckoutCommits({ cwd: repoDir });

    expect(commits.map((entry) => entry.subject)).toEqual([
      "Merge feature",
      "Advance main",
      "Add feature",
      "initial",
    ]);
    expect(commits[0]?.files).toEqual([
      { path: "feature.txt", additions: 1, deletions: 0, status: "added" },
    ]);
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

  it.each([
    {
      label: "without edits",
      content: "one\ntwo\nthree\nfour\nfive\n",
      additions: 0,
      deletions: 0,
    },
    { label: "with edits", content: "one\nTWO\nthree\nfour\nfive\n", additions: 1, deletions: 1 },
  ])(
    "opens a file moved up out of a directory $label",
    async ({ content, additions, deletions }) => {
      const { repoDir } = initRepoOnMain();
      git(["checkout", "-b", "feature"], repoDir);
      mkdirSync(join(repoDir, "src", "nested"), { recursive: true });
      commitFile(repoDir, "src/nested/a.txt", "one\ntwo\nthree\nfour\nfive\n", "Add nested file");
      git(["mv", "src/nested/a.txt", "src/a.txt"], repoDir);
      writeFileSync(join(repoDir, "src/a.txt"), content);
      git(["add", "src/a.txt"], repoDir);
      commit(repoDir, "Move file up");

      const { commits } = await listCheckoutCommits({ cwd: repoDir });

      const movedCommit = commits[0]!;
      const movedFile = movedCommit.files[0]!;
      expect(movedCommit.files).toEqual([
        {
          path: "src/a.txt",
          additions,
          deletions,
          status: "renamed",
        },
      ]);
      expect(
        await getCommitFileDiff({ cwd: repoDir, sha: movedCommit.sha, path: movedFile.path }),
      ).toMatchObject({
        path: "src/a.txt",
        isNew: false,
        isDeleted: false,
        additions,
        deletions,
      });
    },
  );

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

it("compares tag-based worktrees in status, history and legacy diff modes", async () => {
  const { repoDir: mainRepoDir, tempDir } = initRepoOnMain();
  const worktreesRoot = join(tempDir, "worktrees");
  const repoDir = join(worktreesRoot, "repo-hash", "tag-feature");
  mkdirSync(join(worktreesRoot, "repo-hash"), { recursive: true });
  const context = { worktreesRoot };
  git(["tag", "v1"], mainRepoDir);
  git(["worktree", "add", "-b", "tag-feature", repoDir, "v1"], mainRepoDir);
  await writePaseoWorktreeMetadata(repoDir, { baseRefName: "refs/tags/v1" });
  commitFile(repoDir, "tag.txt", "committed\n", "tag feature");
  writeFileSync(join(repoDir, "tag.txt"), "edited\n");
  const status = await getCheckoutStatus(repoDir, context);
  expect(status).toMatchObject({
    isGit: true,
    comparisonBaseRef: "refs/tags/v1",
    aheadBehind: { ahead: 1, behind: 0 },
  });
  const history = await listCheckoutCommits({ cwd: repoDir, context });
  expect(history.baseRef).toBe("refs/tags/v1");
  expect(history.commits[0].subject).toBe("tag feature");
  const committed = await getCheckoutDiff(repoDir, { mode: "base", baseRef: "refs/tags/v1" });
  expect(committed.diff).toContain("+committed");
  const all = await getCheckoutDiff(repoDir, { mode: "all", baseRef: "refs/tags/v1" });
  expect(all.diff).toContain("+edited");
});

it("announces a usable comparison base while checked out on the base branch", async () => {
  const cwd = makeTempDir();
  git(["init", "-b", "main"], cwd);
  git(["config", "user.name", "Test"], cwd);
  git(["config", "user.email", "test@example.com"], cwd);
  writeFileSync(join(cwd, "a.txt"), "before\n");
  git(["add", "."], cwd);
  commit(cwd, "base");
  writeFileSync(join(cwd, "a.txt"), "after\n");
  const status = await getCheckoutStatus(cwd);
  expect(status).toMatchObject({ isGit: true, comparisonBaseRef: "refs/heads/main" });
  if (!status.isGit || !status.comparisonBaseRef) throw new Error("Missing comparison base");
  const all = await getCheckoutDiff(cwd, { mode: "all", baseRef: status.comparisonBaseRef });
  expect(all.diff).toContain("+after");
});
