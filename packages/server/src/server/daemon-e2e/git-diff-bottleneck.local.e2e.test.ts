import { describe, test, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createDaemonTestContext } from "../test-utils/index.js";

const RUN = process.env.PASEO_GIT_DIFF_BOTTLENECK_E2E === "1";
const LARGE_CHANGESET_SIZE = Number.parseInt(
  process.env.PASEO_GIT_DIFF_BOTTLENECK_FILE_COUNT ?? "1200",
  10
);

function tmpRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-git-diff-bottleneck-"));
}

function initGitRepo(cwd: string): void {
  execSync("git init -b main", { cwd, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });
}

function seedLargeDirtyRepo(cwd: string, fileCount: number): void {
  mkdirSync(path.join(cwd, "files"), { recursive: true });
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(path.join(cwd, "files", `f-${i}.txt`), `line ${i}\n`);
  }
  execSync("git add .", { cwd, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'init'", {
    cwd,
    stdio: "pipe",
  });
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(path.join(cwd, "files", `f-${i}.txt`), `line ${i} changed\n`);
  }

  // Explicit binary artifact to verify we do not diff binary contents.
  writeFileSync(path.join(cwd, "blob.bin"), Buffer.from([0x00, 0xff, 0x10, 0x80, 0x00, 0x7f]));
}

const runDescribe = RUN ? describe : describe.skip;

runDescribe("daemon E2E git diff bottleneck profiling", () => {
  test(
    "shows per-file git diff subprocess fanout and timeout pressure",
    async () => {
      const cwd = tmpRepo();

      try {
        initGitRepo(cwd);
        seedLargeDirtyRepo(cwd, LARGE_CHANGESET_SIZE);

        const cliStart = performance.now();
        const cliDiff = execSync("git diff HEAD", { cwd, stdio: "pipe" }).toString();
        const cliMs = performance.now() - cliStart;

        const ctx = await createDaemonTestContext();
        try {
          const checkoutStart = performance.now();
          const checkoutPayload = await ctx.client.getCheckoutDiff(cwd, {
            mode: "uncommitted",
          });
          const checkoutMs = performance.now() - checkoutStart;

          expect(checkoutPayload.error).toBeNull();
          expect(checkoutPayload.files.length).toBeGreaterThanOrEqual(LARGE_CHANGESET_SIZE);

          const binaryEntry = checkoutPayload.files.find((file) => file.path === "blob.bin");
          expect(binaryEntry).toBeTruthy();
          expect(binaryEntry?.status).toBe("binary");

          // Keep this visible in test output for local bottleneck analysis.
          console.info(
            "[git-diff-bottleneck]",
            JSON.stringify(
              {
                fileCount: LARGE_CHANGESET_SIZE,
                cliMs: Math.round(cliMs),
                cliDiffBytes: cliDiff.length,
                checkoutMs: Math.round(checkoutMs),
                checkoutFiles: checkoutPayload.files.length,
                speedRatio: Number((checkoutMs / Math.max(cliMs, 1)).toFixed(2)),
              },
              null,
              2
            )
          );

          expect(checkoutMs).toBeLessThan(cliMs * 10);
        } finally {
          await ctx.cleanup();
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    240000
  );
});
