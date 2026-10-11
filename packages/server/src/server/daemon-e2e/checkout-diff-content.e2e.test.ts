import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
