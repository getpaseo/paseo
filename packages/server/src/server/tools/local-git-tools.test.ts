import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  gitBlame,
  gitBranches,
  gitCheckout,
  gitDiff,
  gitLog,
  gitStash,
  gitStatus,
  parseBlamePorcelain,
  parseGitStatus,
} from "./local-git-tools.js";

let tmp: string;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

function initRepo(cwd: string): void {
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  // Don't sign commits during tests — developer machines often have
  // gpgsign=true globally and the signing key won't be available in CI.
  git(cwd, "config", "commit.gpgsign", "false");
  // Avoid GPG signing even if a tag.gpgsign is set globally.
  git(cwd, "config", "tag.gpgsign", "false");
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hubcode-git-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("parseGitStatus (unit)", () => {
  it("parses a clean tree", () => {
    const r = parseGitStatus("## main...origin/main\n");
    expect(r).toEqual({
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      entries: [],
      clean: true,
    });
  });

  it("parses ahead/behind counts", () => {
    const r = parseGitStatus("## main...origin/main [ahead 2, behind 3]\n");
    expect(r.ahead).toBe(2);
    expect(r.behind).toBe(3);
  });

  it("parses branch with no upstream", () => {
    const r = parseGitStatus("## feature-branch\n");
    expect(r.branch).toBe("feature-branch");
    expect(r.upstream).toBeNull();
  });

  it("parses 'No commits yet' header on a fresh repo", () => {
    const r = parseGitStatus("## No commits yet on main\n?? README.md\n");
    expect(r.branch).toBe("main");
    expect(r.entries).toHaveLength(1);
  });

  it("parses detached HEAD", () => {
    const r = parseGitStatus("## HEAD (no branch)\n");
    expect(r.branch).toBeNull();
  });

  it("parses working-tree modifications", () => {
    const r = parseGitStatus("## main\n M src/index.ts\nA  src/new.ts\n?? todo.md\n");
    expect(r.entries).toEqual([
      { index: " ", worktree: "M", path: "src/index.ts" },
      { index: "A", worktree: " ", path: "src/new.ts" },
      { index: "?", worktree: "?", path: "todo.md" },
    ]);
    expect(r.clean).toBe(false);
  });

  it("parses renames with original path", () => {
    const r = parseGitStatus("## main\nR  old/path -> new/path\n");
    expect(r.entries).toEqual([
      { index: "R", worktree: " ", path: "new/path", originalPath: "old/path" },
    ]);
  });
});

describe("gitStatus (integration)", () => {
  it("reports a clean repo after commit", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "README.md"), "hello");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "initial");
    const r = await gitStatus({ cwd: tmp });
    expect(r.branch).toBe("main");
    expect(r.clean).toBe(true);
    expect(r.entries).toEqual([]);
  });

  it("lists untracked and modified files", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "a.txt"), "1");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    await fs.writeFile(path.join(tmp, "a.txt"), "2");
    await fs.writeFile(path.join(tmp, "b.txt"), "new");
    const r = await gitStatus({ cwd: tmp });
    expect(r.clean).toBe(false);
    const names = r.entries.map((e) => e.path).sort();
    expect(names).toEqual(["a.txt", "b.txt"]);
    const modifiedA = r.entries.find((e) => e.path === "a.txt");
    expect(modifiedA?.worktree).toBe("M");
    const untrackedB = r.entries.find((e) => e.path === "b.txt");
    expect(untrackedB?.index).toBe("?");
    expect(untrackedB?.worktree).toBe("?");
  });

  it("reports staged additions", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "x.txt"), "v1");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    await fs.writeFile(path.join(tmp, "new.txt"), "new");
    git(tmp, "add", "new.txt");
    const r = await gitStatus({ cwd: tmp });
    const entry = r.entries.find((e) => e.path === "new.txt");
    expect(entry?.index).toBe("A");
  });
});

describe("gitDiff (integration)", () => {
  it("returns unstaged diff by default", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "a.txt"), "line one\n");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    await fs.writeFile(path.join(tmp, "a.txt"), "line one changed\n");
    const r = await gitDiff({ cwd: tmp });
    expect(r.diff).toContain("--- a/a.txt");
    expect(r.diff).toContain("+++ b/a.txt");
    expect(r.diff).toContain("-line one");
    expect(r.diff).toContain("+line one changed");
    expect(r.truncated).toBe(false);
  });

  it("returns empty diff for a clean tree", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "x.txt"), "same\n");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    const r = await gitDiff({ cwd: tmp });
    expect(r.diff).toBe("");
    expect(r.truncated).toBe(false);
  });

  it("shows staged diff when staged=true", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "x.txt"), "v1\n");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    await fs.writeFile(path.join(tmp, "x.txt"), "v2\n");
    git(tmp, "add", "x.txt");
    const unstaged = await gitDiff({ cwd: tmp, staged: false });
    expect(unstaged.diff).toBe("");
    const staged = await gitDiff({ cwd: tmp, staged: true });
    expect(staged.diff).toContain("-v1");
    expect(staged.diff).toContain("+v2");
  });

  it("limits diff to a specific path", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "a.txt"), "a\n");
    await fs.writeFile(path.join(tmp, "b.txt"), "b\n");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    await fs.writeFile(path.join(tmp, "a.txt"), "a changed\n");
    await fs.writeFile(path.join(tmp, "b.txt"), "b changed\n");
    const r = await gitDiff({ cwd: tmp, path: "a.txt" });
    expect(r.diff).toContain("a.txt");
    expect(r.diff).not.toContain("b.txt");
  });

  it("flags truncated=true when diff exceeds maxBytes", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "big.txt"), "");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    // 2 KiB of distinct lines so git produces a meaningful diff output
    // for every byte — needed so the process output actually reaches
    // the maxBytes limit we set below.
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    await fs.writeFile(path.join(tmp, "big.txt"), lines);
    const r = await gitDiff({ cwd: tmp, maxBytes: 256 });
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBeGreaterThanOrEqual(256);
  });
});

describe("gitLog (integration)", () => {
  it("returns commits in reverse chronological order", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "a.txt"), "1");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "first");
    await fs.writeFile(path.join(tmp, "a.txt"), "2");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "second");
    const r = await gitLog({ cwd: tmp });
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]!.subject).toBe("second");
    expect(r.entries[1]!.subject).toBe("first");
    expect(r.entries[0]!.author).toBe("Test");
    expect(r.entries[0]!.authorEmail).toBe("test@example.com");
    expect(r.entries[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(r.entries[0]!.shortHash).toMatch(/^[0-9a-f]{7,}$/);
    expect(r.entries[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("respects maxCount", async () => {
    initRepo(tmp);
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tmp, `f${i}.txt`), String(i));
      git(tmp, "add", ".");
      git(tmp, "commit", "-m", `commit ${i}`);
    }
    const r = await gitLog({ cwd: tmp, maxCount: 2 });
    expect(r.entries).toHaveLength(2);
  });

  it("filters by path", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "a.txt"), "a");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "add a");
    await fs.writeFile(path.join(tmp, "b.txt"), "b");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "add b");
    const r = await gitLog({ cwd: tmp, path: "a.txt" });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.subject).toBe("add a");
  });

  it("captures multi-line body", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "a.txt"), "x");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "subject line", "-m", "body line 1\nbody line 2");
    const r = await gitLog({ cwd: tmp });
    expect(r.entries[0]!.subject).toBe("subject line");
    expect(r.entries[0]!.body).toContain("body line 1");
    expect(r.entries[0]!.body).toContain("body line 2");
  });
});

describe("parseBlamePorcelain (unit)", () => {
  it("parses a single line with author and timestamp", () => {
    const raw = [
      "abcdef1234567890abcdef1234567890abcdef12 1 1 1",
      "author Alice Example",
      "author-mail <alice@example.com>",
      "author-time 1700000000",
      "author-tz +0000",
      "committer Alice Example",
      "committer-mail <alice@example.com>",
      "committer-time 1700000000",
      "committer-tz +0000",
      "summary initial",
      "filename README.md",
      "\thello world",
      "",
    ].join("\n");
    const lines = parseBlamePorcelain(raw);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      lineNumber: 1,
      hash: "abcdef1234567890abcdef1234567890abcdef12",
      shortHash: "abcdef1",
      author: "Alice Example",
      date: new Date(1700000000 * 1000).toISOString(),
      content: "hello world",
    });
  });

  it("reuses cached author info for same commit on later lines", () => {
    // Later hunks for the same commit omit the author/time metadata.
    const raw = [
      "aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa 1 1 1",
      "author Bob",
      "author-time 1700000000",
      "summary x",
      "filename f",
      "\tfirst",
      "aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa 2 2 1",
      "\tsecond",
      "",
    ].join("\n");
    const lines = parseBlamePorcelain(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.author).toBe("Bob");
    expect(lines[1]!.author).toBe("Bob");
    expect(lines[1]!.content).toBe("second");
  });
});

describe("gitBlame (integration)", () => {
  it("returns per-line authorship", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "f.txt"), "line1\nline2\n");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    const r = await gitBlame({ cwd: tmp, path: "f.txt" });
    expect(r.path).toBe("f.txt");
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]!.lineNumber).toBe(1);
    expect(r.lines[0]!.content).toBe("line1");
    expect(r.lines[0]!.author).toBe("Test");
    expect(r.lines[1]!.lineNumber).toBe(2);
    expect(r.lines[1]!.content).toBe("line2");
  });

  it("limits range with startLine/endLine", async () => {
    initRepo(tmp);
    await fs.writeFile(
      path.join(tmp, "f.txt"),
      "a\nb\nc\nd\ne\n",
    );
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    const r = await gitBlame({ cwd: tmp, path: "f.txt", startLine: 2, endLine: 4 });
    expect(r.lines.map((l) => l.content)).toEqual(["b", "c", "d"]);
  });
});

describe("gitBranches (integration)", () => {
  it("lists local branches with current marker", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "f.txt"), "x");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    git(tmp, "branch", "feature");
    const r = await gitBranches({ cwd: tmp });
    const names = r.branches.map((b) => b.name).sort();
    expect(names).toEqual(["feature", "main"]);
    const main = r.branches.find((b) => b.name === "main");
    expect(main?.current).toBe(true);
    const feature = r.branches.find((b) => b.name === "feature");
    expect(feature?.current).toBe(false);
    expect(main?.tipHash).toMatch(/^[0-9a-f]{7,}$/);
    expect(main?.tipSubject).toBe("init");
  });
});

describe("gitCheckout (integration)", () => {
  it("creates a new branch with create=true", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "f.txt"), "x");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    const r = await gitCheckout({ cwd: tmp, branch: "feature", create: true });
    expect(r).toEqual({ branch: "feature", created: true, previous: "main" });
    const status = await gitStatus({ cwd: tmp });
    expect(status.branch).toBe("feature");
  });

  it("switches to an existing branch", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "f.txt"), "x");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    git(tmp, "branch", "other");
    const r = await gitCheckout({ cwd: tmp, branch: "other" });
    expect(r).toEqual({ branch: "other", created: false, previous: "main" });
  });

  it("fails cleanly on nonexistent branch", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "f.txt"), "x");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    await expect(
      gitCheckout({ cwd: tmp, branch: "does-not-exist" }),
    ).rejects.toThrow();
  });
});

describe("gitStash (integration)", () => {
  it("saves, lists, and pops a stash", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "f.txt"), "committed\n");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    await fs.writeFile(path.join(tmp, "f.txt"), "dirty\n");
    const saveResult = await gitStash({
      cwd: tmp,
      action: "save",
      message: "wip change",
    });
    expect(saveResult.action).toBe("save");
    expect(saveResult.message).toMatch(/wip change/);

    const listResult = await gitStash({ cwd: tmp, action: "list" });
    expect(listResult.action).toBe("list");
    expect(listResult.entries).toHaveLength(1);
    expect(listResult.entries![0]!.ref).toBe("stash@{0}");
    expect(listResult.entries![0]!.subject).toMatch(/wip change/);

    // File returns to committed state after stash save.
    expect(await fs.readFile(path.join(tmp, "f.txt"), "utf-8")).toBe("committed\n");

    await gitStash({ cwd: tmp, action: "pop" });
    expect(await fs.readFile(path.join(tmp, "f.txt"), "utf-8")).toBe("dirty\n");
    const afterPop = await gitStash({ cwd: tmp, action: "list" });
    expect(afterPop.entries).toHaveLength(0);
  });

  it("drops a stash without restoring", async () => {
    initRepo(tmp);
    await fs.writeFile(path.join(tmp, "f.txt"), "committed\n");
    git(tmp, "add", ".");
    git(tmp, "commit", "-m", "init");
    await fs.writeFile(path.join(tmp, "f.txt"), "dirty\n");
    await gitStash({ cwd: tmp, action: "save" });
    await gitStash({ cwd: tmp, action: "drop" });
    const list = await gitStash({ cwd: tmp, action: "list" });
    expect(list.entries).toHaveLength(0);
    // Working tree stays clean — drop doesn't restore.
    expect(await fs.readFile(path.join(tmp, "f.txt"), "utf-8")).toBe("committed\n");
  });
});
