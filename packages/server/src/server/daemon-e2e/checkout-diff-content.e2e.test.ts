import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createDaemonTestContext } from "../test-utils/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test.each(["uncommitted", "base", "commit"] as const)(
  "%s diff preserves removed SQL comments and their deletion counts",
  async (mode) => {
    const ctx = await createDaemonTestContext();
    const cwd = mkdtempSync(join(tmpdir(), "checkout-diff-content-"));

    try {
      git(cwd, "init", "-b", "main");
      git(cwd, "config", "user.name", "Test");
      git(cwd, "config", "user.email", "test@example.com");
      writeFileSync(join(cwd, "query.sql"), "-- old comment\nSELECT 1;\n");
      writeFileSync(join(cwd, "control.sql"), "SELECT 1;\n");
      git(cwd, "add", ".");
      git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "initial");
      writeFileSync(join(cwd, "query.sql"), "-- new comment\nSELECT 1;\n");
      writeFileSync(join(cwd, "control.sql"), "SELECT 2;\n");

      expect(git(cwd, "diff", "--numstat", "HEAD", "--", "query.sql").trim()).toBe(
        "1\t1\tquery.sql",
      );

      if (mode !== "uncommitted") {
        git(cwd, "checkout", "-b", "feature");
        git(cwd, "add", ".");
        git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "edit");
      }

      const files =
        mode === "commit"
          ? [
              (
                await ctx.client.getCommitFileDiff(
                  cwd,
                  git(cwd, "rev-parse", "HEAD").trim(),
                  "query.sql",
                )
              ).file,
              (
                await ctx.client.getCommitFileDiff(
                  cwd,
                  git(cwd, "rev-parse", "HEAD").trim(),
                  "control.sql",
                )
              ).file,
            ]
          : (await ctx.client.getCheckoutDiff(cwd, { mode, baseRef: "main" })).files;

      const control = files.find((file) => file?.path === "control.sql");
      expect(control).toMatchObject({ additions: 1, deletions: 1 });
      expect(control?.hunks.flatMap((hunk) => hunk.lines)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "remove", content: "SELECT 1;" }),
          expect.objectContaining({ type: "add", content: "SELECT 2;" }),
        ]),
      );

      const query = files.find((file) => file?.path === "query.sql");
      expect
        .soft(query)
        .toMatchObject({ additions: 1, deletions: 1, isNew: false, isDeleted: false });
      expect
        .soft(query?.hunks.flatMap((hunk) => hunk.lines))
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "remove", content: "-- old comment" }),
            expect.objectContaining({ type: "add", content: "-- new comment" }),
            expect.objectContaining({ type: "context", content: "SELECT 1;" }),
          ]),
        );
    } finally {
      await ctx.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  60_000,
);

test.each(
  (["uncommitted", "base"] as const).flatMap((mode) =>
    (["single", "batch", "rename"] as const).map((shape) => ({ mode, shape })),
  ),
)(
  "$mode $shape diff includes hunks from a repository subdirectory",
  async ({ mode, shape }) => {
    const ctx = await createDaemonTestContext();
    const cwd = mkdtempSync(join(tmpdir(), "checkout-diff-subdirectory-"));

    try {
      git(cwd, "init", "-b", "main");
      git(cwd, "config", "user.name", "Test");
      git(cwd, "config", "user.email", "test@example.com");
      git(cwd, "config", "core.autocrlf", "false");
      const subdirectory = join(cwd, "sub");
      mkdirSync(subdirectory);
      const unchangedLines = "unchanged\n".repeat(10);
      writeFileSync(join(subdirectory, "normal.txt"), `before\n${unchangedLines}`);
      if (shape === "batch") {
        writeFileSync(join(cwd, "sibling.txt"), "old sibling\n");
      }
      git(cwd, "add", ".");
      git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "initial");
      if (mode === "base") {
        git(cwd, "checkout", "-b", "feature");
      }
      const filename = shape === "rename" ? "renamed.txt" : "normal.txt";
      if (shape === "rename") {
        git(cwd, "mv", "sub/normal.txt", `sub/${filename}`);
      }
      writeFileSync(join(subdirectory, filename), `after\n${unchangedLines}`);
      if (shape === "batch") {
        writeFileSync(join(cwd, "sibling.txt"), "new sibling\n");
      }
      if (mode === "base") {
        git(cwd, "add", ".");
        git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "edit");
      }

      const compare = { mode, baseRef: "main" };
      const rootDiff = await ctx.client.getCheckoutDiff(cwd, compare);
      const subdirectoryDiff = await ctx.client.getCheckoutDiff(subdirectory, compare);
      const subscription = ctx.client.observeCheckoutDiff(subdirectory, compare);
      const liveDiff = await subscription.ready;
      await subscription.release();

      expect(rootDiff.error).toBeNull();
      expect(subdirectoryDiff.error).toBeNull();
      expect(liveDiff.error).toBeNull();
      expect(liveDiff.files).toEqual(rootDiff.files);
      expect(rootDiff.files).toHaveLength(shape === "batch" ? 2 : 1);
      const file = rootDiff.files.find((candidate) => candidate.path === `sub/${filename}`);
      expect(file).toMatchObject({
        additions: 1,
        deletions: 1,
        ...(shape === "rename" ? { oldPath: "sub/normal.txt" } : {}),
      });
      expect(file?.hunks.flatMap((hunk) => hunk.lines)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "remove", content: "before" }),
          expect.objectContaining({ type: "add", content: "after" }),
        ]),
      );
      expect(subdirectoryDiff.files).toEqual(rootDiff.files);
    } finally {
      await ctx.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  60_000,
);

test("All changes subscriptions refresh on file edits and commits", async () => {
  const ctx = await createDaemonTestContext();
  const cwd = mkdtempSync(join(tmpdir(), "checkout-diff-all-"));
  try {
    git(cwd, "init", "-b", "main");
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "user.email", "test@example.com");
    writeFileSync(join(cwd, "file.txt"), "base\n");
    git(cwd, "add", ".");
    git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "base");
    git(cwd, "checkout", "-b", "feature");
    writeFileSync(join(cwd, "file.txt"), "committed\n");
    git(cwd, "add", ".");
    git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "feature");
    const subscription = ctx.client.observeCheckoutDiff(cwd, { mode: "all", baseRef: "main" });
    try {
      let latest = await subscription.ready;
      expect(latest.error).toBeNull();
      subscription.subscribe({
        snapshot: (snapshot) => {
          latest = snapshot;
        },
        update: (message) => {
          if (message.type === "checkout_diff_update") latest = message.payload;
        },
      });
      writeFileSync(join(cwd, "file.txt"), "working\n");
      await expect
        .poll(
          () =>
            latest.files[0]?.hunks
              .flatMap((hunk) => hunk.lines)
              .filter((line) => line.type === "add")
              .map((line) => line.content),
          { timeout: 15_000 },
        )
        .toEqual(["working"]);
      writeFileSync(join(cwd, "new.txt"), "untracked\n");
      await expect
        .poll(() => latest.files.map((file) => file.path), { timeout: 15_000 })
        .toEqual(["file.txt", "new.txt"]);
      const beforeCommit = latest.files;
      git(cwd, "add", ".");
      git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "working");
      expect(
        (await ctx.client.getCheckoutDiff(cwd, { mode: "all", baseRef: "main" })).files,
      ).toEqual(beforeCommit);
      writeFileSync(join(cwd, "file.txt"), "base\n");
      await expect
        .poll(() => latest.files.map((file) => file.path), { timeout: 15_000 })
        .toEqual(["new.txt"]);
      git(cwd, "checkout", "--", "file.txt");
      await expect
        .poll(() => latest.files.map((file) => file.path), { timeout: 15_000 })
        .toEqual(["file.txt", "new.txt"]);
    } finally {
      await subscription.release();
    }
  } finally {
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
