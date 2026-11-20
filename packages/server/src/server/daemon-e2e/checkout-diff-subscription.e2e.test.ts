import { test, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, execSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import type { SessionOutboundMessage } from "../messages.js";

type CheckoutDiffUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "checkout_diff_update" }
>["payload"];

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-checkout-diff-"));
}

function initGitRepo(cwd: string): void {
  execSync("git init -b main", { cwd, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });
}

function commitFile(cwd: string, fileName: string, content: string): void {
  const filePath = path.join(cwd, fileName);
  writeFileSync(filePath, content);
  execSync(`git add "${fileName}"`, { cwd, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'Initial commit'", {
    cwd,
    stdio: "pipe",
  });
}

async function waitForCheckoutDiffUpdate(
  ctx: DaemonTestContext,
  subscriptionId: string,
  predicate: (payload: CheckoutDiffUpdatePayload) => boolean,
  timeoutMs = 15000,
): Promise<CheckoutDiffUpdatePayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for checkout_diff_update (${subscriptionId})`));
    }, timeoutMs);

    const unsubscribe = ctx.client.on("checkout_diff_update", (message) => {
      if (message.type !== "checkout_diff_update") {
        return;
      }
      if (message.payload.subscriptionId !== subscriptionId) {
        return;
      }
      if (!predicate(message.payload)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(message.payload);
    });
  });
}

let ctx: DaemonTestContext;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
}, 60000);

test("pushes file-level checkout diff updates with deterministic path order", async () => {
  const cwd = tmpCwd();

  try {
    initGitRepo(cwd);
    commitFile(cwd, "base.txt", "base\n");

    const subscription = ctx.client.observeCheckoutDiff(cwd, { mode: "uncommitted" });
    const initial = await subscription.ready;
    const subscriptionId = initial.subscriptionId;

    expect(initial.error).toBeNull();
    expect(initial.files).toEqual([]);

    writeFileSync(path.join(cwd, "zeta.txt"), "zeta\n");
    writeFileSync(path.join(cwd, "alpha.txt"), "alpha\n");

    const update = await waitForCheckoutDiffUpdate(ctx, subscriptionId, (payload) => {
      const paths = new Set(payload.files.map((file) => file.path));
      return paths.has("alpha.txt") && paths.has("zeta.txt");
    });

    expect(update.error).toBeNull();
    expect(update.files.map((file) => file.path)).toEqual(["alpha.txt", "zeta.txt"]);

    await subscription.release();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60000);

test("pushes updates when subscribed from a subdirectory and files change outside it", async () => {
  const cwd = tmpCwd();

  try {
    initGitRepo(cwd);
    commitFile(cwd, "base.txt", "base\n");

    const nestedDir = path.join(cwd, "nested", "dir");
    mkdirSync(nestedDir, { recursive: true });

    const subscription = ctx.client.observeCheckoutDiff(nestedDir, { mode: "uncommitted" });
    const initial = await subscription.ready;
    const subscriptionId = initial.subscriptionId;

    expect(initial.error).toBeNull();
    expect(initial.files).toEqual([]);

    writeFileSync(path.join(cwd, "outside-subdir.txt"), "changed outside\n");

    const update = await waitForCheckoutDiffUpdate(ctx, subscriptionId, (payload) =>
      payload.files.some((file) => file.path === "outside-subdir.txt"),
    );

    expect(update.error).toBeNull();
    expect(update.files.some((file) => file.path === "outside-subdir.txt")).toBe(true);

    await subscription.release();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60000);

test("keeps the socket usable after rejecting an oversized structured diff", async () => {
  const cwd = tmpCwd();

  try {
    initGitRepo(cwd);
    commitFile(cwd, "large-a.js", "const value = 0;\n");
    commitFile(cwd, "large-b.js", "const value = 0;\n");
    // Short lines stay eligible for highlighting; a giant single line is skipped
    // before token expansion and cannot exercise the structured-payload limit.
    // Stay below the full-source highlighting budget as well.
    const denseExpression = `const value = ${"a+".repeat(100)}a;\n`.repeat(3_500);
    writeFileSync(path.join(cwd, "large-a.js"), denseExpression);
    writeFileSync(path.join(cwd, "large-b.js"), denseExpression);

    const subscription = ctx.client.observeCheckoutDiff(cwd, { mode: "uncommitted" });
    const initial = await subscription.ready;

    expect(initial).toMatchObject({
      cwd,
      files: [],
      diffTooLarge: true,
      error: { code: "UNKNOWN" },
    });

    const status = await ctx.client.getCheckoutStatus(cwd);
    expect(status).toMatchObject({ cwd, isGit: true });
    await subscription.release();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120000);

test.skipIf(process.platform !== "linux")(
  "Changes opens and follows Git updates when metadata exceeds the watcher limit",
  async () => {
    const cwd = tmpCwd();
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    try {
      initGitRepo(cwd);
      commitFile(cwd, "tracked.txt", "base\n");
      const head = git("rev-parse", "HEAD");
      git("switch", "-c", "topic");
      commitFile(cwd, "next.txt", "next\n");
      const next = git("rev-parse", "HEAD");
      git("reset", "--hard", head);
      execFileSync("git", ["update-ref", "--stdin"], {
        cwd,
        input: Array.from(
          { length: 5010 },
          (_, i) => `create refs/heads/overflow-${i}/branch ${head}\n`,
        ).join(""),
      });
      writeFileSync(path.join(cwd, "tracked.txt"), "edit\n");

      const changes = ctx.client.observeDiff({
        cwd,
        base: { kind: "rev", rev: "main" },
        head: { kind: "worktree" },
        mergeBase: true,
      });
      let current: import("@getpaseo/client").DiffState | undefined;
      const unsubscribe = changes.subscribe({
        snapshot: (state) => {
          current = state;
        },
        update: () => {},
      });
      try {
        await expect
          .poll(() => current, { timeout: 12000 })
          .toMatchObject({
            phase: "ready",
            files: [{ path: "tracked.txt" }],
          });
        const legacy = ctx.client.observeCheckoutDiff(cwd, { mode: "all", baseRef: "main" });
        try {
          expect(await legacy.ready).toMatchObject({
            error: null,
            files: [{ path: "tracked.txt" }],
          });
        } finally {
          await legacy.release();
        }
        expect(
          await ctx.client.getCheckoutDiff(cwd, { mode: "all", baseRef: "main" }),
        ).toMatchObject({ error: null, files: [{ path: "tracked.txt" }] });

        writeFileSync(path.join(cwd, "working.txt"), "untracked\n");
        await expect
          .poll(() => current, { timeout: 3000 })
          .toMatchObject({
            phase: "ready",
            files: [{ path: "tracked.txt" }, { path: "working.txt" }],
          });

        const staged = ctx.client.observeDiff({
          cwd,
          base: { kind: "rev", rev: head },
          head: { kind: "index" },
        });
        const pinned = ctx.client.observeDiff({
          cwd,
          base: { kind: "empty" },
          head: { kind: "rev", rev: head },
        });
        const selected = ctx.client.observeDiff({
          cwd,
          base: { kind: "rev", rev: head },
          head: { kind: "rev", rev: "main" },
        });
        let stagedState: typeof current;
        let pinnedState: typeof current;
        let selectedState: typeof current;
        const stopStaged = staged.subscribe({
          snapshot: (state) => {
            stagedState = state;
          },
          update: () => {},
        });
        const stopPinned = pinned.subscribe({
          snapshot: (state) => {
            pinnedState = state;
          },
          update: () => {},
        });
        const stopSelected = selected.subscribe({
          snapshot: (state) => {
            selectedState = state;
          },
          update: () => {},
        });
        try {
          await expect.poll(() => stagedState).toMatchObject({ phase: "ready", files: [] });
          await expect
            .poll(() => pinnedState)
            .toMatchObject({
              phase: "ready",
              files: [{ path: "tracked.txt", status: "ok" }],
            });
          await expect.poll(() => selectedState).toMatchObject({ phase: "ready", files: [] });
          git("add", "tracked.txt");
          writeFileSync(path.join(cwd, ".git", "info", "attributes"), "tracked.txt -diff\n");
          git("update-ref", "refs/heads/main", next);
          await expect
            .poll(() => selectedState, { timeout: 17000 })
            .toMatchObject({
              phase: "ready",
              files: [{ path: "next.txt" }],
              resolved: { headSha: next },
            });
          await expect
            .poll(() => stagedState)
            .toMatchObject({
              phase: "ready",
              files: [{ path: "tracked.txt" }],
            });
          await expect
            .poll(() => pinnedState)
            .toMatchObject({
              phase: "ready",
              files: [{ path: "tracked.txt", status: "binary" }],
            });
          git("symbolic-ref", "HEAD", "refs/heads/main");
          await expect
            .poll(() => current, { timeout: 17000 })
            .toMatchObject({
              phase: "ready",
              resolved: { mergeBaseSha: next },
              files: [{ path: "next.txt" }, { path: "tracked.txt" }, { path: "working.txt" }],
            });
          expect(
            await ctx.client.readDiff({
              cwd,
              base: { kind: "rev", rev: "missing-branch" },
              head: { kind: "worktree" },
            }),
          ).toMatchObject({ phase: "error", error: { code: "REF_NOT_FOUND" } });
        } finally {
          stopStaged();
          stopPinned();
          stopSelected();
          await Promise.all([staged.release(), pinned.release(), selected.release()]);
        }
      } finally {
        unsubscribe();
        await changes.release();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  45000,
);
