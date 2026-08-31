import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommitLogCursorError,
  encodeCommitLogCursor,
  listCommitLogPage,
  parseCommitDecoration,
  parseCommitLogRecords,
} from "./checkout-commit-log.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "commit-log-test-")));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
  });
}

function commitFile(repoDir: string, name: string, content: string, message: string): void {
  writeFileSync(join(repoDir, name), content);
  git(["add", "."], repoDir);
  git(["-c", "commit.gpgsign=false", "commit", "-m", message], repoDir);
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
  const startingSha = git(["rev-parse", "HEAD"], repoDir).trim();
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

function headShas(repoDir: string, revision = "HEAD"): string[] {
  return git(["log", revision, "--format=%H"], repoDir).split("\n").filter(Boolean);
}

describe("parseCommitDecoration", () => {
  it("splits a full decoration into classified refs", () => {
    expect(
      parseCommitDecoration(
        "HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD",
      ),
    ).toEqual([
      { kind: "head", name: "HEAD" },
      { kind: "local_branch", name: "main" },
      { kind: "remote_branch", name: "origin/main" },
    ]);
  });

  it("classifies tags and keeps a detached HEAD", () => {
    expect(parseCommitDecoration("tag: refs/tags/v1")).toEqual([{ kind: "tag", name: "v1" }]);
    expect(parseCommitDecoration("HEAD")).toEqual([{ kind: "head", name: "HEAD" }]);
  });

  it("drops refs the user never navigates to", () => {
    expect(parseCommitDecoration("refs/stash")).toEqual([]);
    expect(parseCommitDecoration("refs/notes/commits")).toEqual([]);
    expect(parseCommitDecoration("")).toEqual([]);
  });

  it("treats a comma inside a branch name as one ref", () => {
    // git forbids ASCII space in ref names, so only ", " separates entries.
    expect(parseCommitDecoration("refs/heads/a,b")).toEqual([
      { kind: "local_branch", name: "a,b" },
    ]);
  });
});

describe("parseCommitLogRecords", () => {
  it("keeps subjects containing the delimiters intact", () => {
    const subject = "fix: a, b -> c and tag: not-a-tag";
    const record = `\x1e${"1".repeat(40)}\x001111111\x00Ada\x002026-06-13T10:00:00Z\x00HEAD -> refs/heads/main\x00${subject}\n`;

    expect(parseCommitLogRecords(record)).toEqual([
      {
        sha: "1".repeat(40),
        shortSha: "1111111",
        authorName: "Ada",
        authorDate: "2026-06-13T10:00:00Z",
        refs: [
          { kind: "head", name: "HEAD" },
          { kind: "local_branch", name: "main" },
        ],
        subject,
      },
    ]);
  });
});

describe("listCommitLogPage", () => {
  it("pages head scope without gaps or overlap", async () => {
    const { repoDir } = initRepoOnMain();
    importLinearHistory({ repoDir, branch: "main", file: "a.txt", subject: "Change", count: 59 });
    const expected = headShas(repoDir);
    expect(expected).toHaveLength(60);

    const first = await listCommitLogPage({ cwd: repoDir, scope: "head", limit: 50 });
    expect(first.commits).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(first.cursorExpired).toBe(false);

    const second = await listCommitLogPage({
      cwd: repoDir,
      scope: "head",
      limit: 50,
      cursor: first.nextCursor as string,
    });
    expect(second.commits).toHaveLength(10);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();

    const paged = [...first.commits, ...second.commits].map((commit) => commit.sha);
    expect(paged).toEqual(expected);
  });

  it("decorates the tip commit with its branch refs", async () => {
    const { repoDir } = initRepoOnMain();
    git(["tag", "v1"], repoDir);

    const page = await listCommitLogPage({ cwd: repoDir, scope: "head", limit: 10 });

    expect(page.commits[0]?.refs).toEqual(
      expect.arrayContaining([
        { kind: "head", name: "HEAD" },
        { kind: "local_branch", name: "main" },
        { kind: "tag", name: "v1" },
      ]),
    );
  });

  it("does not shift a later page when new commits land mid-paging", async () => {
    const { repoDir } = initRepoOnMain();
    importLinearHistory({ repoDir, branch: "main", file: "a.txt", subject: "Change", count: 9 });

    const first = await listCommitLogPage({ cwd: repoDir, scope: "head", limit: 5 });
    commitFile(repoDir, "late.txt", "late\n", "Landed mid-paging");

    const second = await listCommitLogPage({
      cwd: repoDir,
      scope: "head",
      limit: 5,
      cursor: first.nextCursor as string,
    });

    const paged = [...first.commits, ...second.commits].map((commit) => commit.sha);
    expect(paged).toEqual(headShas(repoDir, "HEAD~1"));
    expect(paged.some((sha) => sha === headShas(repoDir)[0])).toBe(false);
  });

  it("includes sibling branches only in all scope", async () => {
    const { repoDir } = initRepoOnMain();
    git(["checkout", "-b", "sidebranch"], repoDir);
    commitFile(repoDir, "side.txt", "side\n", "Only on the side branch");
    const sideSha = headShas(repoDir)[0];
    git(["checkout", "main"], repoDir);

    const head = await listCommitLogPage({ cwd: repoDir, scope: "head", limit: 50 });
    const all = await listCommitLogPage({ cwd: repoDir, scope: "all", limit: 50 });

    expect(head.commits.map((commit) => commit.sha)).not.toContain(sideSha);
    expect(all.commits.map((commit) => commit.sha)).toContain(sideSha);
    expect(all.pinnedTipCount).toBeGreaterThan(1);
    expect(all.pinnedTipsTruncated).toBe(false);
  });

  it("reports an expired cursor when the pinned tip is gone", async () => {
    const { repoDir } = initRepoOnMain();
    git(["checkout", "-b", "doomed"], repoDir);
    importLinearHistory({ repoDir, branch: "doomed", file: "a.txt", subject: "Change", count: 5 });

    const first = await listCommitLogPage({ cwd: repoDir, scope: "head", limit: 2 });
    expect(first.nextCursor).not.toBeNull();

    git(["checkout", "main"], repoDir);
    git(["branch", "-D", "doomed"], repoDir);
    git(["reflog", "expire", "--expire=now", "--all"], repoDir);
    git(["gc", "--prune=now", "--quiet"], repoDir);

    const second = await listCommitLogPage({
      cwd: repoDir,
      scope: "head",
      limit: 2,
      cursor: first.nextCursor as string,
    });

    expect(second.cursorExpired).toBe(true);
    expect(second.commits).toEqual([]);
    expect(second.nextCursor).toBeNull();
    expect(second.hasMore).toBe(false);
  });

  it("returns an empty page for an unborn branch", async () => {
    const tempDir = makeTempDir();
    const repoDir = join(tempDir, "empty");
    mkdirSync(repoDir, { recursive: true });
    git(["init", "-b", "main"], repoDir);

    const page = await listCommitLogPage({ cwd: repoDir, scope: "head", limit: 50 });

    expect(page).toMatchObject({
      commits: [],
      hasMore: false,
      nextCursor: null,
      cursorExpired: false,
    });
  });

  it("rejects cursors whose tips are not commit OIDs", async () => {
    const { repoDir } = initRepoOnMain();

    for (const tip of ["../../etc/passwd", "-x", "1".repeat(39), "--all"]) {
      const cursor = encodeCommitLogCursor({ v: 1, scope: "head", tips: [tip], skip: 0 });
      await expect(
        listCommitLogPage({ cwd: repoDir, scope: "head", limit: 10, cursor }),
      ).rejects.toBeInstanceOf(CommitLogCursorError);
    }
  });

  it("rejects a cursor used under a different scope", async () => {
    const { repoDir } = initRepoOnMain();
    const first = await listCommitLogPage({ cwd: repoDir, scope: "head", limit: 1 });
    const cursor = encodeCommitLogCursor({
      v: 1,
      scope: "head",
      tips: [first.commits[0]?.sha as string],
      skip: 1,
    });

    await expect(
      listCommitLogPage({ cwd: repoDir, scope: "all", limit: 10, cursor }),
    ).rejects.toBeInstanceOf(CommitLogCursorError);
  });

  it("rejects a cursor that skips past the paging ceiling", async () => {
    const { repoDir } = initRepoOnMain();
    const sha = headShas(repoDir)[0] as string;
    const cursor = encodeCommitLogCursor({ v: 1, scope: "head", tips: [sha], skip: 10_001 });

    await expect(
      listCommitLogPage({ cwd: repoDir, scope: "head", limit: 10, cursor }),
    ).rejects.toBeInstanceOf(CommitLogCursorError);
  });
});
