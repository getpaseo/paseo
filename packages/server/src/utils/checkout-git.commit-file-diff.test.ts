import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getCommitFileDiff, listCheckoutCommits } from "./checkout-git.js";
import { SessionDelivery } from "../server/session/owned-subscriptions/index.js";
import { startGitCommandMetrics, stopGitCommandMetrics } from "./run-git-command.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "commit-file-diff-test-")));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd }).toString();
}

function commitFile(repoDir: string, name: string, content: string, message: string): void {
  writeFileSync(join(repoDir, name), content);
  git(["add", "."], repoDir);
  git(["-c", "commit.gpgsign=false", "commit", "-m", message], repoDir);
}

function initRepo(): string {
  const tempDir = makeTempDir();
  const repoDir = join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "test@test.com"], repoDir);
  git(["config", "user.name", "Test User"], repoDir);
  return repoDir;
}

function headSha(repoDir: string): string {
  return git(["rev-parse", "HEAD"], repoDir).trim();
}

describe("getCommitFileDiff", () => {
  it.each(["new.txt", "with spaces.txt"])("preserves a rename-only commit to %s", async (name) => {
    const repoDir = initRepo();
    commitFile(repoDir, "old.txt", "same\n", "initial");
    git(["mv", "old.txt", name], repoDir);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "rename"], repoDir);
    const sha = headSha(repoDir);

    const history = await listCheckoutCommits({ cwd: repoDir });
    expect(history.commits.find((commit) => commit.sha === sha)?.files).toEqual([
      { path: name, status: "renamed", additions: 0, deletions: 0 },
    ]);
    expect(await getCommitFileDiff({ cwd: repoDir, sha, path: name })).toEqual({
      path: name,
      isNew: false,
      isDeleted: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    });
  });

  it.each(["new.txt", "目录.txt"])(
    "preserves the edits in a committed rename to %s",
    async (name) => {
      const repoDir = initRepo();
      commitFile(repoDir, "old.txt", "same\nkeep\nlast\n", "initial");
      git(["mv", "old.txt", name], repoDir);
      writeFileSync(join(repoDir, name), "same\nKEEP\nlast\n");
      git(["add", "."], repoDir);
      git(["-c", "commit.gpgsign=false", "commit", "-m", "rename and edit"], repoDir);
      const sha = headSha(repoDir);

      const history = await listCheckoutCommits({ cwd: repoDir });
      expect(history.commits.find((commit) => commit.sha === sha)?.files).toEqual([
        { path: name, status: "renamed", additions: 1, deletions: 1 },
      ]);
      const file = await getCommitFileDiff({ cwd: repoDir, sha, path: name });
      expect(file).toMatchObject({
        path: name,
        isNew: false,
        isDeleted: false,
        additions: 1,
        deletions: 1,
      });
      expect(file?.hunks.flatMap((hunk) => hunk.lines)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "remove", content: "keep" }),
          expect.objectContaining({ type: "add", content: "KEEP" }),
        ]),
      );
    },
  );

  it.skipIf(process.platform === "win32")("preserves a rename to a quoted filename", async () => {
    const repoDir = initRepo();
    const name = 'new "draft".txt';
    commitFile(repoDir, "old.txt", "same\n", "initial");
    git(["mv", "old.txt", name], repoDir);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "rename"], repoDir);
    expect(await getCommitFileDiff({ cwd: repoDir, sha: headSha(repoDir), path: name })).toEqual({
      path: name,
      isNew: false,
      isDeleted: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    });
  });

  it("returns the parsed diff for a modified file in a commit", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "foo.txt", "a\nb\nc\n", "initial");
    commitFile(repoDir, "foo.txt", "a\nB\nc\nd\n", "edit foo");
    const sha = headSha(repoDir);

    const file = await getCommitFileDiff({ cwd: repoDir, sha, path: "foo.txt" });

    expect(file).not.toBeNull();
    expect(file?.path).toBe("foo.txt");
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(1);
    expect(file?.hunks.length).toBeGreaterThan(0);

    const lines = file?.hunks[0]?.lines ?? [];
    expect(lines.some((line) => line.type === "add" && line.content === "B")).toBe(true);
    expect(lines.some((line) => line.type === "add" && line.content === "d")).toBe(true);
    expect(lines.some((line) => line.type === "remove" && line.content === "b")).toBe(true);
  });

  it("returns a diff flagged as new for an added file", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "README.md", "base\n", "initial");
    commitFile(repoDir, "added.txt", "x\ny\n", "add file");
    const sha = headSha(repoDir);

    const file = await getCommitFileDiff({ cwd: repoDir, sha, path: "added.txt" });

    expect(file?.path).toBe("added.txt");
    expect(file?.isNew).toBe(true);
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(0);
  });

  it.each([
    ["exact", "line1\nline2\nline3\nline4\nline5\nline6\n"],
    ["edited", "line1\nline2\nline3\nline4\nline5\nCHANGED\n"],
  ])("shows an added %s copy as a new file", async (_kind, addedContent) => {
    const repoDir = initRepo();
    commitFile(repoDir, "source.txt", "line1\nline2\nline3\nline4\nline5\nline6\n", "initial");
    commitFile(repoDir, "added.txt", addedContent, "add similar file");
    const sha = headSha(repoDir);

    const history = await listCheckoutCommits({ cwd: repoDir });
    expect(history.commits.find((commit) => commit.sha === sha)?.files).toEqual([
      { path: "added.txt", status: "added", additions: 6, deletions: 0 },
    ]);
    const file = await getCommitFileDiff({ cwd: repoDir, sha, path: "added.txt" });
    expect(file).toMatchObject({
      path: "added.txt",
      isNew: true,
      isDeleted: false,
      additions: 6,
      deletions: 0,
    });
    expect(
      file?.hunks
        .flatMap((hunk) => hunk.lines)
        .filter((line) => line.type !== "header")
        .map(({ type, content }) => ({ type, content })),
    ).toEqual(
      addedContent
        .trimEnd()
        .split("\n")
        .map((content) => ({ type: "add", content })),
    );
  });

  it("shares commit rename discovery across concurrent and later file requests", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "old.txt", "same\n", "initial");
    git(["mv", "old.txt", "new.txt"], repoDir);
    commitFile(repoDir, "added.txt", "added\n", "rename and add");
    const sha = headSha(repoDir);

    startGitCommandMetrics();
    try {
      const [renamed, added] = await Promise.all([
        getCommitFileDiff({ cwd: repoDir, sha, path: "new.txt" }),
        getCommitFileDiff({ cwd: repoDir, sha, path: "added.txt" }),
      ]);
      expect(renamed).toMatchObject({ isNew: false, additions: 0, deletions: 0 });
      expect(added).toMatchObject({ isNew: true, additions: 1, deletions: 0 });
      expect(await getCommitFileDiff({ cwd: repoDir, sha, path: "new.txt" })).toEqual(renamed);
    } finally {
      const metrics = stopGitCommandMetrics();
      expect(metrics.commands.filter(({ args }) => args.includes("--name-status"))).toHaveLength(1);
    }
  });

  it("rediscovers renames when a symbolic commit ref moves", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "old.txt", "same\n", "initial");
    expect(await getCommitFileDiff({ cwd: repoDir, sha: "HEAD", path: "old.txt" })).toMatchObject({
      isNew: true,
      additions: 1,
    });
    git(["mv", "old.txt", "new.txt"], repoDir);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "rename"], repoDir);
    expect(await getCommitFileDiff({ cwd: repoDir, sha: "HEAD", path: "new.txt" })).toMatchObject({
      isNew: false,
      additions: 0,
      deletions: 0,
    });
  });

  it("returns null for a path not changed in the commit", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "foo.txt", "a\n", "initial");
    commitFile(repoDir, "foo.txt", "a\nb\n", "edit foo");
    const sha = headSha(repoDir);

    const file = await getCommitFileDiff({ cwd: repoDir, sha, path: "does-not-exist.txt" });

    expect(file).toBeNull();
  });

  it("does not follow an unchanged file back to an earlier commit", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "foo.txt", "same\n", "initial");
    commitFile(repoDir, "other.txt", "other\n", "unrelated change");
    expect(
      await getCommitFileDiff({ cwd: repoDir, sha: headSha(repoDir), path: "foo.txt" }),
    ).toBeNull();
  });

  it("returns the added file in a root commit and the deleted file in its deletion commit", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "foo.txt", "same\n", "initial");
    expect(
      await getCommitFileDiff({ cwd: repoDir, sha: headSha(repoDir), path: "foo.txt" }),
    ).toMatchObject({
      isNew: true,
      isDeleted: false,
      additions: 1,
      deletions: 0,
    });
    git(["rm", "foo.txt"], repoDir);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "delete"], repoDir);
    expect(
      await getCommitFileDiff({ cwd: repoDir, sha: headSha(repoDir), path: "foo.txt" }),
    ).toMatchObject({
      isNew: false,
      isDeleted: true,
      additions: 0,
      deletions: 1,
    });
  });

  it("preserves a rename introduced by a merge against its first parent", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "old.txt", "same\n", "initial");
    git(["checkout", "-b", "feature"], repoDir);
    git(["mv", "old.txt", "new.txt"], repoDir);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "rename"], repoDir);
    git(["checkout", "main"], repoDir);
    commitFile(repoDir, "main.txt", "main\n", "advance main");
    git(["merge", "--no-ff", "feature", "-m", "merge feature"], repoDir);
    expect(
      await getCommitFileDiff({ cwd: repoDir, sha: headSha(repoDir), path: "new.txt" }),
    ).toMatchObject({
      path: "new.txt",
      isNew: false,
      isDeleted: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    });
  });

  it("returns a merge commit diff against its first parent", async () => {
    const repoDir = initRepo();
    commitFile(repoDir, "README.md", "base\n", "initial");
    git(["checkout", "-b", "feature"], repoDir);
    commitFile(repoDir, "feature.txt", "feature\n", "add feature");
    git(["checkout", "main"], repoDir);
    commitFile(repoDir, "main.txt", "main\n", "advance main");
    git(["merge", "--no-ff", "feature", "-m", "merge feature"], repoDir);
    const sha = headSha(repoDir);

    const file = await getCommitFileDiff({ cwd: repoDir, sha, path: "feature.txt" });

    expect(file?.path).toBe("feature.txt");
    expect(file?.isNew).toBe(true);
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(0);
  });
});

it("identical commit-file requests from two requesters both retain syntax tokens", async () => {
  const repoDir = initRepo();
  const original = "const value = Math.max(42, 7);\n".repeat(3_000);
  commitFile(repoDir, "file.ts", original, "initial");
  commitFile(repoDir, "file.ts", original.replace("42", "43"), "edit");
  const input = { cwd: repoDir, sha: headSha(repoDir), path: "file.ts" };
  const results = await Promise.all([getCommitFileDiff(input), getCommitFileDiff(input)]);
  for (const file of results) {
    expect(
      file?.hunks[0].lines
        .find((line) => line.type === "add")
        ?.tokens?.some((token) => token.style !== null),
    ).toBe(true);
  }
});

it("a disconnected requester cancels commit highlighting before its sources arrive", async () => {
  const repoDir = initRepo();
  commitFile(repoDir, "file.ts", "const value = 42;\n", "initial");
  commitFile(repoDir, "file.ts", "const value = 43;\n", "edit");
  const delivery = new SessionDelivery(() => {});
  const source = {};
  delivery.attach(source, true);
  const request = {
    type: "checkout.commits.file_diff.request" as const,
    cwd: repoDir,
    sha: headSha(repoDir),
    path: "file.ts",
    requestId: "disconnect",
  };
  const results: Awaited<ReturnType<typeof getCommitFileDiff>>[] = [];
  const pending = delivery.request(source, request, async () => {
    results.push(await getCommitFileDiff({ ...request, signal: delivery.requestSignal }));
  });
  await delivery.detach(source);
  await pending;
  expect(
    results[0]?.hunks.flatMap((hunk) => hunk.lines).every((line) => line.tokens === undefined),
  ).toBe(true);
});
