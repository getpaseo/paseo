import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

// The app decides whether archiving a worktree needs the uncommitted-changes warning from this
// answer, and the daemon then removes the worktree with `git worktree remove --force`.
// https://github.com/getpaseo/paseo/issues/9701

let ctx: DaemonTestContext;
let repo: string;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  repo = mkdtempSync(path.join(tmpdir(), "checkout-status-freshness-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git("add", "README.md");
  git("-c", "commit.gpgsign=false", "commit", "-m", "initial");
  const opened = await ctx.client.openProject(repo);
  expect(opened.error).toBeNull();
});

afterEach(async () => {
  await ctx.cleanup();
  rmSync(repo, { recursive: true, force: true });
}, 60_000);

test("checkout status reports an edit made right before the request", async () => {
  const before = await ctx.client.getCheckoutStatus(repo);
  expect(before.error).toBeNull();
  expect(before.isDirty).toBe(false);

  writeFileSync(path.join(repo, "README.md"), "hello\nedited\n");
  const after = await ctx.client.getCheckoutStatus(repo);

  expect(after.error).toBeNull();
  expect(after.isDirty).toBe(true);
}, 60_000);

test("checkout status reports a new file created right before the request", async () => {
  const before = await ctx.client.getCheckoutStatus(repo);
  expect(before.isDirty).toBe(false);

  writeFileSync(path.join(repo, "notes.md"), "draft\n");
  const after = await ctx.client.getCheckoutStatus(repo);

  expect(after.error).toBeNull();
  expect(after.isDirty).toBe(true);
}, 60_000);
