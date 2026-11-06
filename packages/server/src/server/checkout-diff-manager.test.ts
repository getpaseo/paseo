import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { expect, test } from "vitest";
import { CheckoutDiffManager, type CheckoutDiffSnapshotPayload } from "./checkout-diff-manager.js";
import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import { createFileObserver } from "./file-observer/index.js";

async function withCheckout(
  run: (input: {
    cwd: string;
    manager: CheckoutDiffManager;
    git(...args: string[]): string;
  }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "legacy-diff-adapter-"));
  const observer = createFileObserver();
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const manager = new CheckoutDiffManager({
    logger: pino({ level: "silent" }),
    paseoHome: cwd,
    workspaceRuntimeStore: createWorkspaceRuntimeStore(),
    workspaceGitService: {
      async requestWorkingTreeWatch(root, onChange) {
        const subscription = await observer.subscribe(root, () => onChange(), {
          ignore: [join(root, ".git")],
        });
        return {
          repoRoot: root,
          unsubscribe: async () => {
            await subscription.unsubscribe();
          },
        };
      },
    },
  });
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "README"), "base\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    await run({ cwd, manager, git });
  } finally {
    await manager.dispose();
    await observer.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("legacy callers share one live comparison, receive edits, and release it", async () => {
  await withCheckout(async ({ cwd, manager }) => {
    await mkdir(join(cwd, "sub"));
    await writeFile(join(cwd, "x.ts"), "const value = 1;\n");
    const first: CheckoutDiffSnapshotPayload[] = [];
    const second: CheckoutDiffSnapshotPayload[] = [];
    const [a, b] = await Promise.all([
      manager.subscribe({ cwd: join(cwd, "sub"), compare: { mode: "uncommitted" } }, (snapshot) =>
        first.push(snapshot),
      ),
      manager.subscribe({ cwd, compare: { mode: "uncommitted" } }, (snapshot) =>
        second.push(snapshot),
      ),
    ]);
    expect(a.initial.cwd).toBe(join(cwd, "sub"));
    expect(a.initial.files).toEqual(b.initial.files);
    expect(a.initial.files.map((file) => file.path)).toEqual(["x.ts"]);
    expect(manager.getMetrics()).toMatchObject({
      checkoutDiffTargetCount: 1,
      checkoutDiffSubscriptionCount: 2,
    });
    await writeFile(join(cwd, "x.ts"), "const value = 2;\n");
    await expect.poll(() => first.length, { timeout: 10000 }).toBeGreaterThan(0);
    expect(first.at(-1)?.files).toEqual(second.at(-1)?.files);
    await a.unsubscribe();
    await b.unsubscribe();
    expect(manager.getMetrics().checkoutDiffTargetCount).toBe(0);
  });
}, 30_000);

test("Committed ignores working-tree edits while All and Uncommitted include them", async () => {
  await withCheckout(async ({ cwd, manager, git }) => {
    git("checkout", "-b", "feature");
    await writeFile(join(cwd, "x.ts"), "const value = 1;\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "feature");
    await writeFile(join(cwd, "x.ts"), "const value = 2;\n");
    const committed = await manager.read({ cwd, compare: { mode: "base", baseRef: "main" } });
    const all = await manager.read({ cwd, compare: { mode: "all", baseRef: "main" } });
    const uncommitted = await manager.read({ cwd, compare: { mode: "uncommitted" } });
    expect(committed.files[0].hunks[0].lines).toContainEqual(
      expect.objectContaining({ type: "add", content: "const value = 1;" }),
    );
    expect(all.files[0].hunks[0].lines).toContainEqual(
      expect.objectContaining({ type: "add", content: "const value = 2;" }),
    );
    expect(uncommitted.files[0].hunks[0].lines).toContainEqual(
      expect.objectContaining({ type: "remove", content: "const value = 1;" }),
    );
  });
}, 30_000);

test("cancelling a legacy subscriber during a shared revision does not revive it", async () => {
  await withCheckout(async ({ cwd, manager }) => {
    await writeFile(join(cwd, "x.ts"), "export const value = 1;\n");
    const abort = new AbortController();
    let cancelled = false;
    const modern = await manager.streams.subscribe(
      { cwd, base: { kind: "rev", rev: "HEAD" }, head: { kind: "worktree" } },
      async (frame) => {
        if (frame.opcode !== 0x40 || cancelled) return;
        await waitForSubscriberCount(manager, 2);
        cancelled = true;
        abort.abort();
      },
    );
    const legacy = manager.subscribe(
      { cwd, compare: { mode: "uncommitted" }, signal: abort.signal },
      () => {
        throw new Error("Cancelled subscriber received an update");
      },
    );
    try {
      await modern.start();
      const result = await legacy;
      expect(result.initial).toMatchObject({
        files: [],
        error: { message: "Diff subscription cancelled" },
      });
      await result.unsubscribe();
    } finally {
      await modern.release();
    }
  });
}, 30_000);

async function waitForSubscriberCount(manager: CheckoutDiffManager, count: number): Promise<void> {
  await expect
    .poll(() => manager.getMetrics().checkoutDiffSubscriptionCount, { timeout: 10_000 })
    .toBe(count);
}

test("moving a tag refreshes binary file metadata even though binary files have no bodies", async () => {
  await withCheckout(async ({ cwd, manager, git }) => {
    git("tag", "v1");
    await writeFile(join(cwd, "image.bin"), Buffer.from([0, 1]));
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "binary");
    await writeFile(join(cwd, "image.bin"), Buffer.from([0, 2]));
    const updates: CheckoutDiffSnapshotPayload[] = [];
    const subscription = await manager.subscribe(
      { cwd, compare: { mode: "all", baseRef: "v1" } },
      (snapshot) => updates.push(snapshot),
    );
    expect(subscription.initial.files[0]).toMatchObject({
      path: "image.bin",
      isNew: true,
      status: "binary",
    });
    git("update-ref", "refs/tags/v1", "HEAD");
    await expect.poll(() => updates.at(-1)?.files[0]?.isNew, { timeout: 10000 }).toBe(false);
    await subscription.unsubscribe();
  });
}, 30000);

test("legacy diffs retain successful bodies when an oversized sibling is removed", async () => {
  await withCheckout(async ({ cwd, manager }) => {
    await writeFile(join(cwd, "a.ts"), "const value = 1;\n");
    await writeFile(join(cwd, "b.txt"), "x".repeat(1024 * 1024 + 1));
    const updates: CheckoutDiffSnapshotPayload[] = [];
    const subscription = await manager.subscribe(
      { cwd, compare: { mode: "uncommitted" } },
      (snapshot) => updates.push(snapshot),
    );
    expect(subscription.initial.files).toMatchObject([
      { path: "a.ts", status: "ok" },
      { path: "b.txt", status: "too_large" },
    ]);
    await rm(join(cwd, "b.txt"));
    manager.scheduleRefreshForCwd(cwd);
    await expect.poll(() => updates.at(-1)?.error).toBeNull();
    expect(updates.at(-1)?.files[0]).toMatchObject({
      path: "a.ts",
      hunks: [
        {
          lines: expect.arrayContaining([expect.objectContaining({ content: "const value = 1;" })]),
        },
      ],
    });
    subscription.unsubscribe();
  });
});
