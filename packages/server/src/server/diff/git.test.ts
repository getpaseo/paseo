import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { listComparison, type Comparison } from "./git.js";

test("working tree comparisons preserve staged deletions whose file remains on disk", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-comparison-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "x.ts"), "const value = 1;\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    git("rm", "--cached", "x.ts");
    await writeFile(join(cwd, "x.ts"), "const value = 2;\n");
    const comparison = await listComparison({
      cwd,
      base: { kind: "rev", rev: "HEAD" },
      head: { kind: "worktree" },
      highlight: false,
    });
    expect(comparison.files.map((file) => file.entry)).toEqual([
      {
        path: "x.ts",
        oldPath: null,
        change: "modified",
        content: "text",
        additions: 1,
        deletions: 1,
        body: true,
      },
    ]);
    const body = await readBody(comparison);
    expect(body.body.hunks[0].lines).toEqual([
      { type: "header", content: "@@ -1 +1 @@" },
      { type: "remove", content: "const value = 1;" },
      { type: "add", content: "const value = 2;" },
    ]);
    expect(comparison.metrics.highlightCalls).toBe(0);
    await comparison.close();
    expect(git("diff", "--cached", "--name-status")).toBe("D\tx.ts");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("supports empty trees, unborn HEAD, staged and unstaged comparisons", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-endpoints-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "x.ts"), "const value = 1;\n");
    const unborn = await listComparison({
      cwd,
      base: { kind: "rev", rev: "HEAD" },
      head: { kind: "worktree" },
    });
    expect(unborn.files.map((file) => file.entry.path)).toEqual(["x.ts"]);
    await unborn.close();
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    const empty = await listComparison({
      cwd,
      base: { kind: "empty" },
      head: { kind: "rev", rev: "HEAD" },
    });
    expect(empty.files[0].entry.change).toBe("added");
    await empty.close();
    await writeFile(join(cwd, "x.ts"), "const value = 2;\n");
    git("add", ".");
    const indexPath = join(cwd, ".git", "index");
    const originalIndex = await readFile(indexPath);
    const originalMtime = (await lstat(indexPath, { bigint: true })).mtimeNs;
    const staged = await listComparison({
      cwd,
      base: { kind: "rev", rev: "HEAD" },
      head: { kind: "index" },
      highlight: false,
    });
    expect(await readFile(indexPath)).toEqual(originalIndex);
    expect((await lstat(indexPath, { bigint: true })).mtimeNs).toBe(originalMtime);
    const stagedSha = staged.headSha;
    expect(staged.files[0].entry).toMatchObject({ additions: 1, deletions: 1 });
    await staged.close();
    await writeFile(join(cwd, "x.ts"), "const value = 3;\n");
    const unstaged = await listComparison({
      cwd,
      base: { kind: "index" },
      head: { kind: "worktree" },
      highlight: false,
    });
    expect(unstaged.baseSha).toBe(stagedSha);
    const record = await readBody(unstaged);
    expect(record.body.hunks[0].lines).toContainEqual({
      type: "remove",
      content: "const value = 2;",
    });
    await unstaged.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("lists oversized untracked files without treating their truncated contents as additions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-large-file-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "README"), "base\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    await writeFile(join(cwd, "huge.ts"), Buffer.alloc(2 * 1024 * 1024, 120));
    const comparison = await listComparison({
      cwd,
      base: { kind: "rev", rev: "HEAD" },
      head: { kind: "worktree" },
    });
    expect(comparison.files[0].entry).toMatchObject({
      path: "huge.ts",
      additions: 0,
      deletions: 0,
      content: "text",
    });
    expect(await comparison.read(comparison.files[0])).toEqual({ kind: "too_large" });
    await comparison.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("preserves highlighting context outside the emitted hunks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-highlight-context-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    const lines = [
      "/*",
      ...Array.from({ length: 30 }, (_, index) => `comment ${index}`),
      "*/",
      "export const value = 1;",
    ];
    await writeFile(join(cwd, "x.ts"), lines.join("\n") + "\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    lines[15] = "new comment";
    await writeFile(join(cwd, "x.ts"), lines.join("\n") + "\n");
    const comparison = await listComparison({
      cwd,
      base: { kind: "rev", rev: "HEAD" },
      head: { kind: "worktree" },
    });
    const record = await readBody(comparison);
    expect(record.body.hunks[0].lines.find((line) => line.type === "add")).toMatchObject({
      content: "new comment",
      runs: [{ style: "comment", length: 11 }],
    });
    await comparison.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reads patches independently of repository color and prefix presentation settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-presentation-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "x.ts"), "before\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    git("config", "color.ui", "always");
    git("config", "diff.noprefix", "true");
    await writeFile(join(cwd, "x.ts"), "after\n");
    const comparison = await listComparison({
      cwd,
      base: { kind: "rev", rev: "HEAD" },
      head: { kind: "worktree" },
      highlight: false,
    });
    const record = await readBody(comparison);
    expect(record.body.hunks).toHaveLength(1);
    expect(record.body.hunks[0].lines).toContainEqual({ type: "add", content: "after" });
    await comparison.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("merge-base index comparisons resolve against HEAD while reporting both endpoint SHAs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-index-merge-base-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "README"), "base\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    const common = git("rev-parse", "HEAD");
    git("checkout", "-b", "side");
    await writeFile(join(cwd, "side.txt"), "side\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "side");
    const side = git("rev-parse", "HEAD");
    git("checkout", "main");
    await writeFile(join(cwd, "main.txt"), "main\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "main");
    await writeFile(join(cwd, "staged.txt"), "staged\n");
    git("add", "staged.txt");
    const comparison = await listComparison({
      cwd,
      base: { kind: "rev", rev: "side" },
      head: { kind: "index" },
      mergeBase: true,
    });
    expect(comparison.baseSha).toBe(side);
    expect(comparison.mergeBaseSha).toBe(common);
    expect(comparison.files.map((file) => file.entry.path)).toEqual(["main.txt", "staged.txt"]);
    await comparison.close();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

async function readBody(comparison: Comparison) {
  const record = await comparison.read(comparison.files[0]);
  if (record.kind !== "ready") throw new Error("Expected a readable file body");
  return record;
}
