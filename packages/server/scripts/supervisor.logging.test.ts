import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { isPlatform } from "../src/test-utils/platform.js";
import { resolveSupervisorLogFile } from "./supervisor-log-config.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const supervisorPath = fileURLToPath(new URL("./supervisor.ts", import.meta.url));

async function runSupervisorFixture(options: {
  workerSource: string;
  restartOnCrash?: boolean;
}): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  log: string;
  stdout: string;
  stderr: string;
}> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "paseo-supervisor-log-"));
  const logPath = path.join(tempDir, "daemon.log");
  const workerPath = path.join(tempDir, "worker.mjs");
  const runnerPath = path.join(tempDir, "runner.mjs");

  await writeFile(workerPath, options.workerSource);
  await writeFile(
    runnerPath,
    `
      import { runSupervisor } from ${JSON.stringify(pathToFileURL(supervisorPath).href)};

      runSupervisor({
        name: "TestSupervisor",
        startupMessage: "starting fixture",
        resolveWorkerEntry: () => ${JSON.stringify(workerPath)},
        workerArgs: [],
        workerEnv: process.env,
        workerExecArgv: [],
        restartOnCrash: ${JSON.stringify(options.restartOnCrash ?? false)},
        logFile: {
          path: ${JSON.stringify(logPath)},
          rotate: { maxSize: "1m", maxFiles: 2 },
        },
      });
    `,
  );

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("supervisor fixture timed out"));
    }, 10000);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode, exitSignal) => {
      clearTimeout(timeout);
      resolve({ code: exitCode, signal: exitSignal });
    });
  });

  const log = await readFile(logPath, "utf8");
  return { code, signal, log, stdout, stderr };
}

describe("supervisor durable logging", () => {
  test("resolves rotation defaults", () => {
    const paseoHome = path.join(path.sep, "tmp", "paseo-home");
    const logFile = resolveSupervisorLogFile(paseoHome, {}, {});

    expect(logFile).toEqual({
      path: path.join(paseoHome, "daemon.log"),
      rotate: { maxSize: "10m", maxFiles: 3 },
    });
  });

  test("lets persisted rotation override env rotation defaults", () => {
    const paseoHome = path.join(path.sep, "tmp", "paseo-home");
    const logFile = resolveSupervisorLogFile(
      paseoHome,
      {
        log: {
          file: {
            path: "logs/daemon.log",
            rotate: { maxSize: "25m", maxFiles: 4 },
          },
        },
      },
      {
        PASEO_LOG_ROTATE_SIZE: "200m",
        PASEO_LOG_ROTATE_COUNT: "12",
      },
    );

    expect(logFile).toEqual({
      path: path.resolve(paseoHome, "logs", "daemon.log"),
      rotate: { maxSize: "25m", maxFiles: 4 },
    });
  });

  test("uses env rotation when persisted rotation is absent", () => {
    const paseoHome = path.join(path.sep, "tmp", "paseo-home");
    const logFile = resolveSupervisorLogFile(
      paseoHome,
      {},
      {
        PASEO_LOG_ROTATE_SIZE: "50m",
        PASEO_LOG_ROTATE_COUNT: "8",
      },
    );

    expect(logFile).toEqual({
      path: path.join(paseoHome, "daemon.log"),
      rotate: { maxSize: "50m", maxFiles: 8 },
    });
  });

  test("writes supervised worker stdout and stderr to daemon.log", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.stdout.write('{"level":30,"msg":"worker-json-stdout"}\\n');
        process.stderr.write('{"level":50,"msg":"worker-json-stderr"}\\n');
        process.exit(0);
      `,
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.log).toContain('"worker-json-stdout"');
    expect(result.log).toContain('"worker-json-stderr"');
    expect(result.stdout).toContain('"worker-json-stdout"');
    expect(result.stderr).toContain('"worker-json-stderr"');
  });

  test("preserves raw non-JSON stdout and stderr lines", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.stdout.write('raw stdout line\\n');
        process.stderr.write('raw stderr line\\n');
        process.exit(0);
      `,
    });

    expect(result.log).toContain("raw stdout line\n");
    expect(result.log).toContain("raw stderr line\n");
  });

  test("logs the worker shutdown reason before signaling the worker", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.send?.({ type: "paseo:shutdown", reason: "client_shutdown_rpc" });
        setInterval(() => {}, 1000);
      `,
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.log).toContain('"msg":"Worker requested shutdown"');
    expect(result.log).toContain('"reason":"client_shutdown_rpc"');
    expect(result.log).toContain('"msg":"Supervisor sending signal to worker"');
    expect(result.log).toContain('"signal":"SIGTERM"');
    expect(result.log).toContain('"workerPid":');
  });

  // POSIX-only: Windows reports the worker self-kill as an exit code, not SIGKILL.
  test.skipIf(isPlatform("win32"))(
    "logs worker signal exits even when the worker cannot log",
    async () => {
      const result = await runSupervisorFixture({
        workerSource: `
        process.kill(process.pid, "SIGKILL");
      `,
      });

      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.log).toContain('"msg":"Worker exited"');
      expect(result.log).toContain('"signal":"SIGKILL"');
      expect(result.log).toContain("Supervisor exiting");
    },
  );
});
