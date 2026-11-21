import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { settleProviderCleanups, spawnProviderProcess } from "./spawn.js";

const logger = pino({ level: "silent" });
let tempDir: string;
const started: number[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "provider-process-"));
});

afterEach(async () => {
  for (const pid of started.splice(0)) {
    if (isRunning(pid)) process.kill(pid, "SIGKILL");
  }
  await rm(tempDir, { recursive: true, force: true });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readPid(path: string): Promise<number | null> {
  try {
    return Number.parseInt(await readFile(path, "utf8"), 10);
  } catch {
    return null;
  }
}

// A provider stand-in that starts a long-running command the way Claude Code does: detached,
// so on POSIX it leads its own session and is outside the provider's process group.
function spawnProviderWithCommand(commandPidPath: string): ChildProcess {
  const command = `
    require("node:fs").writeFileSync(${JSON.stringify(commandPidPath)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const provider = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(command)}], { detached: true, stdio: "ignore" }).unref();
    setInterval(() => {}, 1000);
  `;
  const child = spawnProviderProcess(process.execPath, ["-e", provider], {
    envMode: "internal",
    stdio: "ignore",
    logger,
  });
  if (child.pid !== undefined) started.push(child.pid);
  return child;
}

async function startedCommand(commandPidPath: string): Promise<number> {
  let pid: number | null = null;
  await waitFor(async () => {
    pid = await readPid(commandPidPath);
    return pid !== null && isRunning(pid);
  }, "the provider's command did not start");
  if (pid === null) throw new Error("unreachable");
  started.push(pid);
  return pid;
}

function exitOf(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

describe("spawnProviderProcess", () => {
  test("stops a command the provider left running when the provider is killed", async () => {
    const provider = spawnProviderWithCommand(join(tempDir, "command.pid"));
    const commandPid = await startedCommand(join(tempDir, "command.pid"));

    const exited = exitOf(provider);
    provider.kill("SIGKILL");
    await exited;
    await settleProviderCleanups();

    // Stopped; the wait only covers its new parent reaping it.
    await waitFor(() => !isRunning(commandPid), "the provider's command kept running");
  });

  test("leaves another provider's command running", async () => {
    const first = spawnProviderWithCommand(join(tempDir, "first.pid"));
    const second = spawnProviderWithCommand(join(tempDir, "second.pid"));
    const firstCommand = await startedCommand(join(tempDir, "first.pid"));
    const secondCommand = await startedCommand(join(tempDir, "second.pid"));

    const exited = exitOf(first);
    first.kill("SIGKILL");
    await exited;
    await settleProviderCleanups();
    await waitFor(() => !isRunning(firstCommand), "the first provider's command kept running");

    expect(isRunning(secondCommand)).toBe(true);
    expect(isRunning(second.pid ?? -1)).toBe(true);
  });
});
