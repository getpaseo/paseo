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

    const subscriptionId = "checkout-diff-e2e-subscription";
    const initial = await ctx.client.subscribeCheckoutDiff(
      cwd,
      { mode: "uncommitted" },
      { subscriptionId },
    );

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

    ctx.client.unsubscribeCheckoutDiff(subscriptionId);
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

    const subscriptionId = "checkout-diff-subdir-e2e-subscription";
    const initial = await ctx.client.subscribeCheckoutDiff(
      nestedDir,
      { mode: "uncommitted" },
      { subscriptionId },
    );

    expect(initial.error).toBeNull();
    expect(initial.files).toEqual([]);

    writeFileSync(path.join(cwd, "outside-subdir.txt"), "changed outside\n");

    const update = await waitForCheckoutDiffUpdate(ctx, subscriptionId, (payload) =>
      payload.files.some((file) => file.path === "outside-subdir.txt"),
    );

    expect(update.error).toBeNull();
    expect(update.files.some((file) => file.path === "outside-subdir.txt")).toBe(true);

    ctx.client.unsubscribeCheckoutDiff(subscriptionId);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60000);

test("pushes submodule worktree and commit-only HEAD updates", async () => {
  const tempDir = tmpCwd();
  const sourceDir = path.join(tempDir, "submodule-source");
  const repoDir = path.join(tempDir, "superproject");
  mkdirSync(sourceDir);
  mkdirSync(repoDir);

  try {
    initGitRepo(sourceDir);
    commitFile(sourceDir, "service.ts", "export const value = 1;\n");

    initGitRepo(repoDir);
    commitFile(repoDir, "README.md", "root\n");
    execFileSync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", sourceDir, "modules/service"],
      { cwd: repoDir, stdio: "pipe" },
    );
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "Add service submodule"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    const submoduleDir = path.join(repoDir, "modules/service");
    const pinnedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: submoduleDir,
      encoding: "utf8",
    }).trim();
    const subscriptionId = "checkout-diff-submodule-e2e-subscription";
    const initial = await ctx.client.subscribeCheckoutDiff(
      repoDir,
      { mode: "uncommitted" },
      { subscriptionId },
    );

    expect(initial.error).toBeNull();
    expect(initial.files).toEqual([]);
    expect(initial.submodules).toEqual([]);

    const dirtyUpdatePromise = waitForCheckoutDiffUpdate(ctx, subscriptionId, (payload) => {
      const file = payload.files.find(
        (candidate) => candidate.path === "modules/service/service.ts",
      );
      const submodule = payload.submodules?.find(
        (candidate) => candidate.path === "modules/service",
      );
      return (
        file?.submodulePath === "modules/service" && submodule?.changeState === "worktree_modified"
      );
    });
    writeFileSync(path.join(submoduleDir, "service.ts"), "export const value = 2;\n");
    const dirtyUpdate = await dirtyUpdatePromise;

    expect(dirtyUpdate.error).toBeNull();
    expect(
      dirtyUpdate.files.map((file) => ({
        path: file.path,
        submodulePath: file.submodulePath,
      })),
    ).toEqual([
      {
        path: "modules/service/service.ts",
        submodulePath: "modules/service",
      },
    ]);
    expect(dirtyUpdate.submodules).toEqual([
      {
        path: "modules/service",
        branch: "main",
        currentSha: pinnedSha,
        headPinnedSha: pinnedSha,
        checkoutState: "checked_out",
        changeState: "worktree_modified",
      },
    ]);

    const committedUpdatePromise = waitForCheckoutDiffUpdate(ctx, subscriptionId, (payload) => {
      const submodule = payload.submodules?.find(
        (candidate) => candidate.path === "modules/service",
      );
      return (
        payload.files.length === 0 &&
        submodule?.changeState === "head_differs" &&
        submodule.currentSha !== pinnedSha
      );
    });
    execFileSync("git", ["add", "service.ts"], { cwd: submoduleDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "Update service"], {
      cwd: submoduleDir,
      stdio: "pipe",
    });
    const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: submoduleDir,
      encoding: "utf8",
    }).trim();
    const committedUpdate = await committedUpdatePromise;

    expect(committedUpdate.error).toBeNull();
    expect(committedUpdate.files).toEqual([]);
    expect(committedUpdate.submodules).toEqual([
      {
        path: "modules/service",
        branch: "main",
        currentSha,
        headPinnedSha: pinnedSha,
        checkoutState: "checked_out",
        changeState: "head_differs",
      },
    ]);

    ctx.client.unsubscribeCheckoutDiff(subscriptionId);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}, 60000);

test("keeps the socket usable after rejecting an oversized structured diff", async () => {
  const cwd = tmpCwd();

  try {
    initGitRepo(cwd);
    commitFile(cwd, "large-a.js", "const value = 0;\n");
    commitFile(cwd, "large-b.js", "const value = 0;\n");
    // Keep each line under the 10k-char syntax-highlight cap (MAX_DIFF_HIGHLIGHT_LINE_CHARS)
    // so highlighting is actually applied; the dense `a+` tokens then expand the structured
    // diff past the relay frame budget (CHECKOUT_DIFF_MAX_STRUCTURED_BYTES) and get rejected.
    // A single 10M+-char line would instead skip highlighting and stay small.
    const denseLine = `const v = ${"a+".repeat(2_000)}a;`;
    const denseContent = `${Array.from({ length: 235 }, () => denseLine).join("\n")}\n`;
    writeFileSync(path.join(cwd, "large-a.js"), denseContent);
    writeFileSync(path.join(cwd, "large-b.js"), denseContent);

    const initial = await ctx.client.subscribeCheckoutDiff(
      cwd,
      { mode: "uncommitted" },
      { subscriptionId: "oversized-checkout-diff" },
    );

    expect(initial).toMatchObject({
      cwd,
      files: [],
      diffTooLarge: true,
      error: { code: "UNKNOWN" },
    });

    const status = await ctx.client.getCheckoutStatus(cwd);
    expect(status).toMatchObject({ cwd, isGit: true });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120000);
