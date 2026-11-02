import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Regression for #3905. Real Codex, synthetic on-disk history, no model turns.
// Opt in because the oversized cases need approximately 2 GiB of memory and over
// 1 GiB of temporary storage.
const enabled = process.env.PASEO_CODEX_HISTORY_STRING_LIMIT_REPRO === "1";
const script = fileURLToPath(
  new URL("../../../../scripts/reproduce-codex-history-string-limit.mts", import.meta.url),
);

test.runIf(enabled).each([
  { megabytes: 2, historyMode: "legacy", expected: "History loaded: 3 timeline rows" },
  { megabytes: 520, historyMode: "legacy", expected: "codex migrate-rollouts --apply --thread" },
  { megabytes: 520, historyMode: "paginated", expected: "History loaded: 521 timeline rows" },
])(
  "opening $megabytes MiB of $historyMode Codex history does not crash its hosting process",
  async ({ megabytes, historyMode, expected }) => {
    const root = await mkdtemp(path.join(process.cwd(), ".codex-history-test-"));
    try {
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve) => {
          const child = execFile(
            process.execPath,
            ["--import", "tsx", script, String(megabytes), historyMode],
            {
              cwd: root,
              detached: true,
              timeout: 120_000,
              maxBuffer: 1024 * 1024,
            },
            (error, stdout, stderr) => {
              try {
                if (child.pid) process.kill(-child.pid, "SIGKILL");
              } catch (killError) {
                if ((killError as NodeJS.ErrnoException).code !== "ESRCH") throw killError;
              }
              resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
            },
          );
        },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(expected);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  180_000,
);
