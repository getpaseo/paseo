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

test.each(["worktree", "index", "rev"] as const)(
  "%s whitespace filtering omits spacing-only edits and retains meaningful edits",
  async (headKind) => {
    const cwd = await mkdtemp(join(tmpdir(), "diff-whitespace-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    try {
      git("init", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      await writeFile(join(cwd, "a.ts"), "const x = 1;\n");
      await writeFile(join(cwd, "b.txt"), "before\n");
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-m", "base");
      const base = git("rev-parse", "HEAD").trim();
      await writeFile(join(cwd, "a.ts"), "const  x = 1;\n");
      await writeFile(join(cwd, "b.txt"), "after\n");
      if (headKind !== "worktree") git("add", ".");
      if (headKind === "rev") git("-c", "commit.gpgsign=false", "commit", "-m", "edit");
      const head = headKind === "rev" ? { kind: "rev" as const, rev: "HEAD" } : { kind: headKind };
      const comparison = await listComparison({
        cwd,
        base: { kind: "rev", rev: base },
        head,
        ignoreWhitespace: true,
        highlight: false,
      });
      expect(comparison.files.map((file) => file.entry.path)).toEqual(["b.txt"]);
      await comparison.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "comparison roots preserve trailing folder spaces",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "diff-space-"));
    const cwd = join(root, "repo ");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cwd);
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd });
      const { worktreeRoot } = await import("./git.js");
      expect(await worktreeRoot(cwd)).toBe(cwd);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["worktree", "index", "rev"] as const)(
  "%s rename reads select the destination when the old path becomes a directory",
  async (headKind) => {
    const cwd = await mkdtemp(join(tmpdir(), "diff-rename-directory-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const { mkdir } = await import("node:fs/promises");
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      await writeFile(join(cwd, "a.txt"), "original line\n".repeat(16));
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-m", "base");
      const base = git("rev-parse", "HEAD");
      git("mv", "a.txt", "z.txt");
      await writeFile(join(cwd, "z.txt"), "original line\n".repeat(16) + "renamed line\n");
      await mkdir(join(cwd, "a.txt"));
      await writeFile(join(cwd, "a.txt", "child.txt"), "replacement line\n");
      git("add", ".");
      if (headKind === "rev") git("-c", "commit.gpgsign=false", "commit", "-m", "rename");
      const head = headKind === "rev" ? { kind: "rev" as const, rev: "HEAD" } : { kind: headKind };
      const comparison = await listComparison({
        cwd,
        base: { kind: "rev", rev: base },
        head,
        highlight: false,
      });
      try {
        const file = comparison.files.find((candidate) => candidate.entry.path === "z.txt");
        if (!file) throw new Error("Missing rename");
        expect(file.entry.oldPath).toBe("a.txt");
        const record = await comparison.read(file);
        if (record.kind !== "ready") throw new Error("Expected readable rename");
        const lines = record.body.hunks.flatMap((hunk) => hunk.lines.map((line) => line.content));
        expect(lines).toContain("renamed line");
        expect(lines).not.toContain("replacement line");
      } finally {
        await comparison.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a dangling untracked symlink exposes its target text alongside tracked changes",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "diff-dangling-link-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    const { symlink } = await import("node:fs/promises");
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      await writeFile(join(cwd, "a.txt"), "before\n");
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-m", "base");
      await writeFile(join(cwd, "a.txt"), "after\n");
      await symlink("not-created-yet", join(cwd, "link"));
      const comparison = await listComparison({
        cwd,
        base: { kind: "rev", rev: "HEAD" },
        head: { kind: "worktree" },
        highlight: false,
      });
      try {
        expect(comparison.files.map((file) => file.entry.path)).toEqual(["a.txt", "link"]);
        const record = await comparison.read(comparison.files[1]);
        if (record.kind !== "ready") throw new Error("Expected link body");
        expect(record.body.hunks.flatMap((hunk) => hunk.lines)).toContainEqual({
          type: "add",
          content: "not-created-yet",
        });
      } finally {
        await comparison.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("untracked nested repositories do not hide tracked edits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-nested-repository-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const { mkdir } = await import("node:fs/promises");
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    await writeFile(join(cwd, "a.txt"), "before\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    await writeFile(join(cwd, "a.txt"), "after\n");
    await mkdir(join(cwd, "nested"));
    git("-C", "nested", "init");
    const comparison = await listComparison({
      cwd,
      base: { kind: "rev", rev: "HEAD" },
      head: { kind: "worktree" },
      highlight: false,
    });
    try {
      expect(comparison.files.map((file) => file.entry.path)).toEqual(["a.txt"]);
      const record = await readBody(comparison);
      expect(record.body.hunks.flatMap((hunk) => hunk.lines)).toContainEqual({
        type: "add",
        content: "after",
      });
    } finally {
      await comparison.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test.each(["worktree", "index", "rev"] as const)(
  "%s preserves hunks for paths containing a patch prefix delimiter",
  async (headKind) => {
    const cwd = await mkdtemp(join(tmpdir(), "diff-path-delimiter-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const { mkdir } = await import("node:fs/promises");
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      await mkdir(join(cwd, "dir b"));
      await writeFile(join(cwd, "dir b", "file.txt"), "before\n");
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-m", "base");
      const base = git("rev-parse", "HEAD");
      await writeFile(join(cwd, "dir b", "file.txt"), "after\n");
      if (headKind !== "worktree") git("add", ".");
      if (headKind === "rev") git("-c", "commit.gpgsign=false", "commit", "-m", "edit");
      const head = headKind === "rev" ? { kind: "rev" as const, rev: "HEAD" } : { kind: headKind };
      const comparison = await listComparison({
        cwd,
        base: { kind: "rev", rev: base },
        head,
        highlight: false,
      });
      try {
        expect(comparison.files[0].entry.path).toBe("dir b/file.txt");
        const record = await readBody(comparison);
        expect(record.body.hunks.flatMap((hunk) => hunk.lines)).toContainEqual({
          type: "add",
          content: "after",
        });
      } finally {
        await comparison.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("highlighted BOM source content survives the production frame codec", async () => {
  const { encodeDiffFrame, decodeDiffFrame } =
    await import("@getpaseo/protocol/binary-frames/index");
  const cwd = await mkdtemp(join(tmpdir(), "diff-bom-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    git("init", "-b", "main");
    await writeFile(join(cwd, "bom.ts"), "\uFEFFexport const value = 1;\n");
    const comparison = await listComparison({
      cwd,
      base: { kind: "empty" },
      head: { kind: "worktree" },
    });
    try {
      const record = await readBody(comparison);
      const frame = { opcode: 0x41 as const, slot: 0, revision: 1, files: [record.body] };
      expect(decodeDiffFrame(encodeDiffFrame(frame))).toEqual(frame);
      expect(
        record.body.hunks
          .flatMap((hunk) => hunk.lines)
          .some((line) => line.content.startsWith("\uFEFF")),
      ).toBe(true);
    } finally {
      await comparison.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "symlink replacement retains both patch sections",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "diff-type-change-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    const { symlink, unlink } = await import("node:fs/promises");
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      await symlink("old-target", join(cwd, "file.txt"));
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-m", "base");
      await unlink(join(cwd, "file.txt"));
      await writeFile(join(cwd, "file.txt"), "replacement contents\n");
      const comparison = await listComparison({
        cwd,
        base: { kind: "rev", rev: "HEAD" },
        head: { kind: "worktree" },
        highlight: false,
      });
      try {
        expect(comparison.files[0].entry).toMatchObject({ additions: 1, deletions: 1 });
        const record = await readBody(comparison);
        expect(record.body.hunks.flatMap((hunk) => hunk.lines)).toEqual(
          expect.arrayContaining([
            { type: "remove", content: "old-target" },
            { type: "add", content: "replacement contents" },
          ]),
        );
      } finally {
        await comparison.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "highlighted symlink replacements use stored link text instead of target contents",
  async () => {
    const { encodeDiffFrame, decodeDiffFrame } =
      await import("@getpaseo/protocol/binary-frames/index");
    const cwd = await mkdtemp(join(tmpdir(), "diff-highlighted-link-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    const { symlink, unlink } = await import("node:fs/promises");
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      await writeFile(join(cwd, "file.ts"), "export const old = 1;\n");
      await writeFile(join(cwd, "target.ts"), "export const entirelyDifferentLength = 2;\n");
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-m", "base");
      await unlink(join(cwd, "file.ts"));
      await symlink("target.ts", join(cwd, "file.ts"));
      const comparison = await listComparison({
        cwd,
        base: { kind: "rev", rev: "HEAD" },
        head: { kind: "worktree" },
      });
      try {
        const record = await readBody(comparison);
        expect(record.body.hunks.flatMap((hunk) => hunk.lines)).toContainEqual(
          expect.objectContaining({ type: "add", content: "target.ts" }),
        );
        const frame = { opcode: 0x41 as const, slot: 0, revision: 1, files: [record.body] };
        expect(decodeDiffFrame(encodeDiffFrame(frame))).toEqual(frame);
      } finally {
        await comparison.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("files removed between listing and highlighting retain their deletion patch", async () => {
  const { encodeDiffFrame, decodeDiffFrame } =
    await import("@getpaseo/protocol/binary-frames/index");
  const cwd = await mkdtemp(join(tmpdir(), "diff-source-disappeared-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    await writeFile(join(cwd, "a.ts"), "export const old = 1;\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    await writeFile(join(cwd, "a.ts"), "export const old = 2;\n");
    const comparison = await listComparison({
      cwd,
      base: { kind: "rev", rev: "HEAD" },
      head: { kind: "worktree" },
    });
    try {
      expect(comparison.files[0].entry.change).toBe("modified");
      await rm(join(cwd, "a.ts"));
      const record = await readBody(comparison);
      expect(record.body.hunks.flatMap((hunk) => hunk.lines)).toContainEqual(
        expect.objectContaining({ type: "remove", content: "export const old = 1;" }),
      );
      const frame = { opcode: 0x41 as const, slot: 0, revision: 1, files: [record.body] };
      expect(decodeDiffFrame(encodeDiffFrame(frame))).toEqual(frame);
    } finally {
      await comparison.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a batched oversized tracked patch does not hide its small sibling", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-batch-budget-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    await writeFile(join(cwd, "a.txt"), "before\n");
    await writeFile(join(cwd, "b.txt"), "before\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    await writeFile(join(cwd, "a.txt"), "oversized\n".repeat(1024 * 1024));
    await writeFile(join(cwd, "b.txt"), "after\n");
    const comparison = await listComparison({
      cwd,
      base: { kind: "rev", rev: "HEAD" },
      head: { kind: "worktree" },
      highlight: false,
    });
    try {
      expect(await comparison.read(comparison.files[0])).toEqual({ kind: "too_large" });
      const sibling = await comparison.read(comparison.files[1]);
      if (sibling.kind !== "ready") throw new Error("Expected readable sibling");
      expect(sibling.body.hunks.flatMap((hunk) => hunk.lines)).toContainEqual({
        type: "add",
        content: "after",
      });
    } finally {
      await comparison.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("replacing a submodule with a regular file preserves its replacement body", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-gitlink-replacement-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const { mkdir } = await import("node:fs/promises");
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    await mkdir(join(cwd, "sub"));
    git("-C", "sub", "init", "-b", "main");
    git("-C", "sub", "config", "user.name", "Test");
    git("-C", "sub", "config", "user.email", "test@example.com");
    await writeFile(join(cwd, "sub", "a.txt"), "base\n");
    git("-C", "sub", "add", ".");
    git("-C", "sub", "-c", "commit.gpgsign=false", "commit", "-m", "base");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "record submodule");
    await rm(join(cwd, "sub"), { recursive: true, force: true });
    await writeFile(join(cwd, "sub"), "replacement contents\n");
    const comparison = await listComparison({
      cwd,
      base: { kind: "rev", rev: "HEAD" },
      head: { kind: "worktree" },
    });
    try {
      const record = await readBody(comparison);
      expect(record.body.hunks.flatMap((hunk) => hunk.lines)).toContainEqual(
        expect.objectContaining({ type: "add", content: "replacement contents" }),
      );
    } finally {
      await comparison.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test.each([
  { ignoreWhitespace: false, after: "export const value = 2;\n", files: ["a.ts"] },
  { ignoreWhitespace: true, after: "export  const value = 1;\n", files: [] },
])(
  "interpretation checks ignore content edits but detect new binary attributes, whitespace=$ignoreWhitespace",
  async ({ ignoreWhitespace, after, files }) => {
    const cwd = await mkdtemp(join(tmpdir(), "diff-interpretation-check-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      git("config", "core.autocrlf", "false");
      await writeFile(join(cwd, "a.ts"), "export const value = 1;\n");
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-m", "base");
      const base = git("rev-parse", "HEAD");
      await writeFile(join(cwd, "a.ts"), after);
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-m", "edit");
      const compare = {
        cwd,
        base: { kind: "rev" as const, rev: base },
        head: { kind: "rev" as const, rev: git("rev-parse", "HEAD") },
        ignoreWhitespace,
        highlight: false,
      };
      const comparison = await listComparison(compare);
      try {
        expect(comparison.files.map((file) => file.entry.path)).toEqual(files);
        expect(await comparison.hasInterpretationChanged()).toBe(false);
        await writeFile(join(cwd, "a.ts"), "uncommitted content\n");
        expect(await comparison.hasInterpretationChanged()).toBe(false);
        await writeFile(join(cwd, ".gitattributes"), "a.ts -diff\n");
        expect(await comparison.hasInterpretationChanged()).toBe(true);
        const fresh = await listComparison(compare);
        try {
          expect(fresh.files.map((file) => file.entry)).toEqual([
            expect.objectContaining({ path: "a.ts", content: "binary" }),
          ]);
        } finally {
          await fresh.close();
        }
      } finally {
        await comparison.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
