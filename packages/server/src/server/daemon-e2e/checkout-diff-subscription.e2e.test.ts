import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
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
  timeoutMs = 15000
): Promise<CheckoutDiffUpdatePayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `Timed out waiting for checkout_diff_update (${subscriptionId})`
        )
      );
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

describe("daemon E2E checkout diff subscriptions", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  test(
    "pushes file-level checkout diff updates with deterministic path order",
    async () => {
      const cwd = tmpCwd();

      try {
        initGitRepo(cwd);
        commitFile(cwd, "base.txt", "base\n");

        const subscriptionId = "checkout-diff-e2e-subscription";
        const initial = await ctx.client.subscribeCheckoutDiff(
          cwd,
          { mode: "uncommitted" },
          { subscriptionId }
        );

        expect(initial.error).toBeNull();
        expect(initial.files).toEqual([]);

        writeFileSync(path.join(cwd, "zeta.txt"), "zeta\n");
        writeFileSync(path.join(cwd, "alpha.txt"), "alpha\n");

        const update = await waitForCheckoutDiffUpdate(
          ctx,
          subscriptionId,
          (payload) => {
            const paths = payload.files.map((file) => file.path);
            return paths.includes("alpha.txt") && paths.includes("zeta.txt");
          }
        );

        expect(update.error).toBeNull();
        expect(update.files.map((file) => file.path)).toEqual([
          "alpha.txt",
          "zeta.txt",
        ]);

        ctx.client.unsubscribeCheckoutDiff(subscriptionId);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    60000
  );
});
