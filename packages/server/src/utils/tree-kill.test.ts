import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createProcessGroupTarget } from "../server/managed-processes/managed-processes.js";
import { terminateWithTreeKill } from "./tree-kill.js";

const pollIntervalMs = 50;

let tempDir: string | null = null;
let ownerProcess: ChildProcess | null = null;
let descendantPid: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  async function poll(): Promise<void> {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(pollIntervalMs);
    return poll();
  }
  return poll();
}

async function readPidFileNumber(filePath: string): Promise<number | null> {
  try {
    const raw = (await readFile(filePath, "utf-8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killIfRunning(pid: number | null | undefined): void {
  if (!pid || !isProcessRunning(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore cleanup races.
  }
}

function spawnOwnerWithDescendant(options: {
  childPidPath: string;
  detachedDescendant: boolean;
  detachedOwner?: boolean;
}): ChildProcess {
  const descendantOptions = options.detachedDescendant
    ? '{ detached: true, stdio: "ignore" }'
    : '{ stdio: "ignore" }';
  const childUnref = options.detachedDescendant ? "child.unref();" : "";

  return spawn(
    process.execPath,
    [
      "-e",
      `
        const { spawn } = require("node:child_process");
        process.on("SIGTERM", () => {});
        const child = spawn(process.execPath, [
          "-e",
          ${JSON.stringify(`
            const fs = require("node:fs");
            process.on("SIGTERM", () => {});
            fs.writeFileSync(${JSON.stringify(options.childPidPath)}, String(process.pid));
            setInterval(() => {}, 1000);
          `)}
        ], ${descendantOptions});
        ${childUnref}
        setInterval(() => {}, 1000);
      `,
    ],
    { stdio: "ignore", detached: options.detachedOwner ?? false },
  );
}

async function waitForFixtureReady(childPidPath: string): Promise<void> {
  await waitFor(
    async () => {
      descendantPid = await readPidFileNumber(childPidPath);
      return (
        isProcessRunning(ownerProcess?.pid ?? -1) &&
        descendantPid !== null &&
        isProcessRunning(descendantPid)
      );
    },
    5000,
    "owner descendant did not become running in time",
  );
}

async function expectOwnerAndDescendantStopped(message: string): Promise<void> {
  await waitFor(
    () => !isProcessRunning(ownerProcess?.pid ?? -1) && !isProcessRunning(descendantPid ?? -1),
    5000,
    message,
  );
}

afterEach(async () => {
  killIfRunning(ownerProcess?.pid);
  killIfRunning(descendantPid);
  ownerProcess = null;
  descendantPid = null;

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("terminateWithTreeKill", () => {
  test("signals a verified process directly without asynchronous tree discovery", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const target = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill(signal?: NodeJS.Signals | number) {
        signals.push(signal);
        return true;
      },
      once() {},
    };

    const termination = terminateWithTreeKill(target, {
      gracefulTimeoutMs: 0,
      signalProcessOnly: true,
    });

    expect(signals).toEqual(["SIGTERM"]);
    expect(await termination).toBe("killed");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("signals a verified process-group target directly", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const target = {
      pid: -12345,
      exitCode: null,
      signalCode: null,
      kill(signal?: NodeJS.Signals | number) {
        signals.push(signal);
        return true;
      },
      once() {},
    };

    const result = await terminateWithTreeKill(target, {
      gracefulTimeoutMs: 0,
      beforeSignal: async () => true,
    });

    expect(result).toBe("killed");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("revalidates process identity before force escalation", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const identityChecks: NodeJS.Signals[] = [];
    const target = {
      exitCode: null,
      signalCode: null,
      kill(signal?: NodeJS.Signals | number) {
        signals.push(signal);
        return true;
      },
      once() {},
    };

    const result = await terminateWithTreeKill(target, {
      gracefulTimeoutMs: 0,
      forceTimeoutMs: 0,
      beforeSignal: async (signal) => {
        identityChecks.push(signal);
        return signal === "SIGTERM";
      },
    });

    expect(result).toBe("signal-skipped");
    expect(identityChecks).toEqual(["SIGTERM", "SIGKILL"]);
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("cancels process observation when identity verification skips signaling", async () => {
    let observationsCancelled = 0;
    const target = {
      exitCode: null,
      signalCode: null,
      kill() {
        return true;
      },
      observeExit() {
        return () => {
          observationsCancelled += 1;
        };
      },
    };

    const result = await terminateWithTreeKill(target, {
      gracefulTimeoutMs: 0,
      beforeSignal: async () => false,
    });

    expect(result).toBe("signal-skipped");
    expect(observationsCancelled).toBe(1);
  });

  test.runIf(process.platform === "win32")(
    "kills Windows descendants through taskkill tree cleanup",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: false,
      });
      expect(ownerProcess.pid).toBeTypeOf("number");
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 2000,
        forceTimeoutMs: 2000,
      });

      // tree-kill uses taskkill /T /F on Windows, so the first signal is already forceful.
      expect(result).toBe("terminated");
      await expectOwnerAndDescendantStopped(
        "owner or Windows descendant survived terminateWithTreeKill",
      );
    },
  );

  test.runIf(process.platform !== "win32")(
    "signals a detached owner process group without asynchronous tree discovery",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-process-group-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: false,
        detachedOwner: true,
      });
      expect(ownerProcess.pid).toBeTypeOf("number");
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(createProcessGroupTarget(ownerProcess.pid!), {
        gracefulTimeoutMs: 100,
        forceTimeoutMs: 2000,
      });

      expect(result).toBe("killed");
      await expectOwnerAndDescendantStopped(
        "owner or same-process-group descendant survived terminateWithTreeKill",
      );
    },
  );

  test.runIf(process.platform !== "win32")(
    "force-kills descendants that started their own process group",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: true,
      });
      expect(ownerProcess.pid).toBeTypeOf("number");
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 100,
        forceTimeoutMs: 2000,
      });

      expect(result).toBe("killed");
      await expectOwnerAndDescendantStopped(
        "owner or separate-process-group descendant survived terminateWithTreeKill",
      );
    },
  );
});
