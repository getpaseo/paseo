import { describe, expect, test } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

type RunResult = { code: number; stdout: string; stderr: string };

function isCodexAvailable(): boolean {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (d) => stdoutChunks.push(d));
    child.stderr.on("data", (d) => stderrChunks.push(d));

    const timeout = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

describe("Codex CLI full-access sandbox", () => {
  test("can listen on unix socket (no EPERM)", { timeout: 240_000 }, async (ctx) => {
      if (process.env.PASEO_CODEX_CLI_E2E !== "1") {
        ctx.skip();
      }
      if (!isCodexAvailable()) {
        ctx.skip();
      }

      const testDir = path.dirname(fileURLToPath(import.meta.url));
      const repoRoot = path.resolve(testDir, "../../../../../..");

      const prompt =
        "Run exactly this shell command and then stop:\n" +
        "bash -lc 'node scripts/repro-ipc-listen.js; echo EXIT_CODE:$?'\n" +
        "Reply with only the raw command stdout/stderr (no extra text).";

      const result = await run(
        "codex",
        [
          "-a",
          "never",
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          "--color",
          "never",
          "-C",
          repoRoot,
          prompt,
        ],
        {
          cwd: repoRoot,
          env: process.env,
          timeoutMs: 180_000,
        },
      );

      const output = `${result.stdout}\n${result.stderr}`;
      if (result.code !== 0) {
        throw new Error(`codex exited ${result.code}\n--- output ---\n${output}`);
      }
      expect(output).toMatch(/\bsandbox:\s*danger-full-access\b/);
      expect(output).toMatch(/\bLISTENING\b/);
      expect(output).toMatch(/\bEXIT_CODE:0\b/);
      expect(output).not.toMatch(/\bEPERM\b/);
    });
});
