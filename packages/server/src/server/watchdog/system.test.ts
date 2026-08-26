import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { DetachedWatchdogLauncher, FileWatchdogResultReader } from "./system.js";
import { runWatchdogWorker } from "./worker.js";

let tempHome: string | null = null;

afterEach(async () => {
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

describe("watchdog worker", () => {
  test("runs an argv command without a shell and writes durable output and result files", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-worker-"));
    const paths = {
      result: path.join(tempHome, "watchdogs", "results", "job-1.json"),
      stdout: path.join(tempHome, "watchdogs", "logs", "job-1.stdout.log"),
      stderr: path.join(tempHome, "watchdogs", "logs", "job-1.stderr.log"),
    };

    await runWatchdogWorker({
      cwd: tempHome,
      command: process.execPath,
      args: ["-e", "process.stdout.write('done\\n'); process.stderr.write('warning\\n')"],
      ...paths,
    });

    const reader = new FileWatchdogResultReader(tempHome);
    expect(await reader.read("job-1")).toEqual({
      exitCode: 0,
      signal: null,
      error: null,
      finishedAt: expect.any(String),
      stdout: { bytes: 5, truncated: false },
      stderr: { bytes: 8, truncated: false },
    });
    expect(await readFile(paths.stdout, "utf8")).toBe("done\n");
    expect(await readFile(paths.stderr, "utf8")).toBe("warning\n");
    if (process.platform !== "win32") {
      expect((await stat(paths.result)).mode & 0o777).toBe(0o600);
    }
  });

  test("the detached launcher executes the TypeScript worker in development", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-system-"));
    const launcher = new DetachedWatchdogLauncher(tempHome);
    const reader = new FileWatchdogResultReader(tempHome);

    const launched = await launcher.launch({
      jobId: "dev-worker",
      cwd: tempHome,
      command: process.execPath,
      args: ["-e", "console.log('detached-dev-ok')"],
    });

    expect(launched.pid).toBeGreaterThan(0);
    let result = null;
    for (let attempt = 0; attempt < 100 && result === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      result = await reader.read("dev-worker");
    }
    expect(result).toMatchObject({ exitCode: 0, error: null });
    expect(
      await readFile(path.join(tempHome, "watchdogs", "logs", "dev-worker.stdout.log"), "utf8"),
    ).toBe("detached-dev-ok\n");
  });

  test("terminates a command when its timeout expires", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-timeout-"));
    const paths = {
      result: path.join(tempHome, "result.json"),
      stdout: path.join(tempHome, "stdout.log"),
      stderr: path.join(tempHome, "stderr.log"),
    };
    const startedAt = Date.now();

    await runWatchdogWorker({
      cwd: tempHome,
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 500)"],
      timeoutMs: 50,
      ...paths,
    });

    expect(Date.now() - startedAt).toBeLessThan(450);
    expect(JSON.parse(await readFile(paths.result, "utf8"))).toMatchObject({
      exitCode: null,
      terminationReason: "timeout",
    });
  });

  test("terminates a command after a durable cancellation request", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-cancel-"));
    const cancel = path.join(tempHome, "cancel.json");
    const paths = {
      result: path.join(tempHome, "result.json"),
      stdout: path.join(tempHome, "stdout.log"),
      stderr: path.join(tempHome, "stderr.log"),
    };
    const running = runWatchdogWorker({
      cwd: tempHome,
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 500)"],
      cancel,
      ...paths,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(cancel, "{}", "utf8");

    await running;

    expect(JSON.parse(await readFile(paths.result, "utf8"))).toMatchObject({
      exitCode: null,
      terminationReason: "cancelled",
    });
  });

  test("bounds captured stdout and records truncation metadata", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-bound-"));
    const paths = {
      result: path.join(tempHome, "result.json"),
      stdout: path.join(tempHome, "stdout.log"),
      stderr: path.join(tempHome, "stderr.log"),
    };

    await runWatchdogWorker({
      cwd: tempHome,
      command: process.execPath,
      args: ["-e", "process.stdout.write('abcdefghij')"],
      maxStreamBytes: 4,
      ...paths,
    });

    expect(JSON.parse(await readFile(paths.result, "utf8"))).toMatchObject({
      exitCode: 0,
      stdout: { bytes: 4, truncated: true },
    });
    expect(await readFile(paths.stdout, "utf8")).toBe("abcd");
  });
});
